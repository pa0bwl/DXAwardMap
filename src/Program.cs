// DX Award Map - desktop program (tray icon + local web server + log readers).
// C# 5 / .NET Framework 4.8 so it builds with the compiler that ships with Windows (see build.ps1).
// Built as 32-bit so it can use Windows' own Access engine (Jet 4.0) to read N3FJP logs without Office.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("DX Award Map")]
[assembly: AssemblyProduct("DX Award Map")]
[assembly: AssemblyVersion("0.9.0.0")]
[assembly: AssemblyFileVersion("0.9.0.0")]

namespace DxAwardMap
{
    static class App
    {
        public const string Name = "DX Award Map";
        public const string Version = "0.9.0";
        public const string ProjectUrl = "https://github.com/pa0bwl/DXAwardMap";
        public static string BaseDir;          // folder with web/, data/, packs/
        public static string StateDir;         // %APPDATA%\DXAwardMap
        public static NotifyIcon Tray;
        public static Form Ui;                 // hidden form used to run dialogs on the UI thread
        public static Settings Cfg;
        public static LogStore Store;
        public static WebServer Server;

        [STAThread]
        static void Main(string[] args)
        {
            bool noWindow = args.Contains("--no-window");
            BaseDir = AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(BaseDir, "web", "index.html")) && File.Exists(Path.Combine(BaseDir, "..", "web", "index.html")))
                BaseDir = Path.GetFullPath(Path.Combine(BaseDir, ".."));   // running from bin\ during development
            StateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DXAwardMap");
            // development/testing: --state=<folder> runs a separate copy with its own settings and data
            string stateArg = args.FirstOrDefault(a => a.StartsWith("--state="));
            if (stateArg != null) StateDir = Path.GetFullPath(stateArg.Substring(8));
            Directory.CreateDirectory(StateDir);

            bool first;
            using (Mutex mutex = new Mutex(true, "DXAwardMap.SingleInstance" + (stateArg != null ? "." + Util.Hash(StateDir) : ""), out first))
            {
                if (!first)
                {
                    int p; if (int.TryParse(Util.ReadText(Path.Combine(StateDir, "port.txt")), out p)) Util.OpenWindow(p);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Cfg = Settings.Load();
                Ui = new Form { ShowInTaskbar = false, WindowState = FormWindowState.Minimized, FormBorderStyle = FormBorderStyle.FixedToolWindow, Opacity = 0 };
                Ui.Load += delegate { Ui.Hide(); };
                IntPtr h = Ui.Handle; // create the handle so Invoke works

                Store = new LogStore();
                Server = new WebServer();
                try { Server.Start(Cfg.Port); }
                catch (Exception ex) { MessageBox.Show("Could not start the local web server: " + ex.Message, Name, MessageBoxButtons.OK, MessageBoxIcon.Error); return; }

                Tray = new NotifyIcon { Icon = Util.MakeIcon(), Text = Name, Visible = true };
                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add("Open map", null, delegate { Util.OpenWindow(Server.Port); });
                menu.Items.Add("Settings", null, delegate { Util.OpenWindow(Server.Port, "#settings"); });
                menu.Items.Add("Reload log now", null, delegate { ThreadPool.QueueUserWorkItem(delegate { Store.Reload(true); }); });
                menu.Items.Add("Project page", null, delegate { Process.Start(ProjectUrl); });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Quit", null, delegate { Tray.Visible = false; Application.Exit(); });
                Tray.ContextMenuStrip = menu;
                Tray.DoubleClick += delegate { Util.OpenWindow(Server.Port); };

                ThreadPool.QueueUserWorkItem(delegate { Store.Reload(true); });
                ThreadPool.QueueUserWorkItem(delegate { AwardLists.CheckOnStart(); });
                System.Threading.Timer poll = new System.Threading.Timer(delegate { Store.Reload(false); }, null, 10000, 10000);
                if (!noWindow) Util.OpenWindow(Server.Port, Cfg.IsConfigured ? "" : "#settings");
                Application.Run();
                poll.Dispose();
                Server.Stop();
                Tray.Dispose();
            }
        }

        public static void Notify(string text, bool warn)
        {
            if (Tray != null) Tray.ShowBalloonTip(8000, Name, text, warn ? ToolTipIcon.Warning : ToolTipIcon.Info);
        }
    }

    // ------------------------------------------------------------------ settings
    class Settings
    {
        public string Source = "n3fjp";       // "n3fjp" or "adif"
        public string N3fjpPath = "";         // empty = N3FJP's active log
        public string AdifPath = "";
        public int Port = 8766;
        public bool StartWithWindows;
        public bool IsConfigured;
        public Dictionary<string, object> Ui = new Dictionary<string, object>();       // page preferences (operators, confirmations, ...)
        public Dictionary<string, object> Mapping = new Dictionary<string, object>();  // "pack/award" -> list of sources (overrides pack defaults)

        static string FilePath { get { return Path.Combine(App.StateDir, "settings.json"); } }

        public static Settings Load()
        {
            Settings s = new Settings();
            try
            {
                if (!File.Exists(FilePath)) return s;
                Dictionary<string, object> d = Json.Parse(File.ReadAllText(FilePath)) as Dictionary<string, object>;
                if (d == null) return s;
                s.FromDict(d); s.IsConfigured = true;
            }
            catch { }
            return s;
        }

        public void FromDict(Dictionary<string, object> d)
        {
            object v;
            if (d.TryGetValue("source", out v) && (v as string == "adif" || v as string == "n3fjp")) Source = (string)v;
            if (d.TryGetValue("n3fjpPath", out v)) N3fjpPath = Convert.ToString(v) ?? "";
            if (d.TryGetValue("adifPath", out v)) AdifPath = Convert.ToString(v) ?? "";
            if (d.TryGetValue("port", out v)) { int p; if (int.TryParse(Convert.ToString(v), out p) && p > 1024 && p < 65535) Port = p; }
            if (d.TryGetValue("startWithWindows", out v) && v is bool) StartWithWindows = (bool)v;
            if (d.TryGetValue("ui", out v) && v is Dictionary<string, object>) Ui = (Dictionary<string, object>)v;
            if (d.TryGetValue("mapping", out v) && v is Dictionary<string, object>) Mapping = (Dictionary<string, object>)v;
        }

        public Dictionary<string, object> ToDict()
        {
            return new Dictionary<string, object> {
                { "source", Source }, { "n3fjpPath", N3fjpPath }, { "adifPath", AdifPath }, { "port", Port },
                { "startWithWindows", StartWithWindows }, { "ui", Ui }, { "mapping", Mapping }, { "configured", IsConfigured } };
        }

        public void Save()
        {
            IsConfigured = true;
            File.WriteAllText(FilePath, Json.Write(ToDict()), new UTF8Encoding(false));
            try
            {
                using (RegistryKey run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (StartWithWindows) run.SetValue(App.Name, "\"" + Application.ExecutablePath + "\" --no-window");
                    else if (run.GetValue(App.Name) != null) run.DeleteValue(App.Name);
                }
            }
            catch { }
        }
    }

    // ------------------------------------------------------------------ log data
    // One QSO row as sent to the page: key, call, date (yyyy-mm-dd), band, mode, dxcc, confirmations (L/E/C letters), operator, then the extra fields.
    class LogStore
    {
        readonly object gate = new object();
        readonly object reloadGate = new object();
        string json = "{\"meta\":{\"status\":\"loading\"},\"rows\":[]}";
        string version = "none";
        string fingerprint = "";
        DateTime lastFull = DateTime.MinValue;
        public string Status = "loading";
        public string Error = "";
        public string FileName = "";
        public int Count;
        public string Engine = "";
        public List<string> ExtraFields = new List<string>();

        public string Json { get { lock (gate) return json; } }
        public string Version { get { lock (gate) return version; } }

        public ILogSource CreateSource()
        {
            if (App.Cfg.Source == "adif") return new AdifSource(App.Cfg.AdifPath);
            return new N3fjpSource(App.Cfg.N3fjpPath);
        }

        // force: always re-read. Otherwise re-read when the file changed, and every 60 s anyway
        // (Windows does not always update the timestamp of a file that N3FJP keeps open).
        public void Reload(bool force)
        {
            if (!Monitor.TryEnter(reloadGate)) return;
            try
            {
                ILogSource src = CreateSource();
                string fp = src.Fingerprint();
                bool due = (DateTime.UtcNow - lastFull).TotalSeconds >= 60;
                if (!force && fp == fingerprint && !due) return;
                Dictionary<string, HashSet<int>> need = Packs.NeededFields(App.Cfg.Source);
                List<string> extra = need.Keys.OrderBy(k => k).ToList();
                List<object[]> rows = src.ReadRows(extra);
                // blank fields for countries that do not use them (keeps the data small)
                for (int fi = 0; fi < extra.Count; fi++) { HashSet<int> dxs = need[extra[fi]]; foreach (object[] r in rows) if (!dxs.Contains((int)r[5])) r[8 + fi] = ""; }
                lastFull = DateTime.UtcNow; fingerprint = fp;
                string rowsJson = DxAwardMap.Json.Write(rows);
                string v = Util.Hash(rowsJson + "|" + string.Join(",", extra));
                lock (gate)
                {
                    Status = "ok"; Error = ""; FileName = src.FileName; Count = rows.Count; Engine = src.Engine; ExtraFields = extra;
                    if (v == version) return;
                    Dictionary<string, object> meta = new Dictionary<string, object> {
                        { "status", "ok" }, { "version", v }, { "source", App.Cfg.Source }, { "file", src.FileName }, { "engine", src.Engine },
                        { "read", DateTime.Now.ToString("yyyy-MM-dd HH:mm") }, { "count", rows.Count },
                        { "columns", new[] { "key", "call", "date", "band", "mode", "dxcc", "conf", "op" }.Concat(extra).ToArray() } };
                    json = "{\"meta\":" + DxAwardMap.Json.Write(meta) + ",\"rows\":" + rowsJson + "}";
                    version = v;
                }
            }
            catch (Exception ex)
            {
                bool changed;
                lock (gate)
                {
                    changed = Status != "error" || Error != ex.Message;
                    Status = "error"; Error = ex.Message;
                    if (changed) version = "error-" + Util.Hash(ex.Message);
                    if (Count == 0) json = "{\"meta\":{\"status\":\"error\",\"error\":" + DxAwardMap.Json.Write(ex.Message) + ",\"version\":\"" + version + "\"},\"rows\":[]}";
                }
                if (changed && App.Cfg.IsConfigured) App.Notify("Could not read the log: " + ex.Message, true);
            }
            finally { Monitor.Exit(reloadGate); }
        }
    }

    interface ILogSource
    {
        string FileName { get; }
        string Engine { get; }
        string Fingerprint();
        List<object[]> ReadRows(List<string> extraFields);
        // field name -> [filled count, sample values...], optionally only for some DXCC numbers
        List<Dictionary<string, object>> FieldStats(HashSet<int> dxcc);
    }

    static class Bands
    {
        // canonical band ids: metres without unit ("20", "2", "2190") and "70cm"/"23cm"/... for UHF and up
        public static string FromN3fjp(string b)
        {
            b = (b ?? "").Trim().ToLowerInvariant();
            switch (b) { case "70": return "70cm"; case "33": return "33cm"; case "23": return "23cm"; case "13": return "13cm"; case "9": return "9cm"; case "6cm": return "6cm"; case "3": return "3cm"; }
            return b.Replace("m", "");
        }
        public static string FromAdif(string b)
        {
            b = (b ?? "").Trim().ToLowerInvariant();
            if (b.EndsWith("cm") || b.EndsWith("mm")) return b;
            return b.EndsWith("m") ? b.Substring(0, b.Length - 1) : b;
        }
    }

    class N3fjpSource : ILogSource
    {
        readonly string path;
        string engine = "";
        public N3fjpSource(string configured) { path = string.IsNullOrEmpty(configured) ? FindActiveLog() : configured; }
        public string FileName { get { return Path.GetFileName(path); } }
        public string Engine { get { return engine; } }

        public static string SettingsXml { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), @"Affirmatech\N3FJP Software\ACLog\Settings.xml"); } }

        public static string FindActiveLog()
        {
            if (!File.Exists(SettingsXml)) throw new Exception("N3FJP ACLog settings not found. Choose the log file in Settings.");
            // Settings.xml has no single root element: read the one tag we need (it also holds passwords, which we never read)
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(SettingsXml), "<USERPATHFILE>(.*?)</USERPATHFILE>");
            if (!m.Success) throw new Exception("No active log found in N3FJP settings. Choose the log file in Settings.");
            return m.Groups[1].Value;
        }

        // titles the user gave to Other1..Other8 in N3FJP
        public static Dictionary<string, string> OtherTitles()
        {
            Dictionary<string, string> d = new Dictionary<string, string>();
            try
            {
                string x = File.ReadAllText(SettingsXml);
                foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(x, "<USEROTHER(\\d)TITLE>(.*?)</USEROTHER\\dTITLE>"))
                    d["fldOther" + m.Groups[1].Value] = m.Groups[2].Value;
            }
            catch { }
            return d;
        }

        public string Fingerprint()
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) throw new Exception("Log file not found: " + path);
            return path + "|" + fi.LastWriteTimeUtc.Ticks + "|" + fi.Length;
        }

        // N3FJP keeps its database open: always work on a temporary copy, never on the original file
        System.Data.OleDb.OleDbConnection OpenCopy(out string tmp)
        {
            tmp = Path.Combine(Path.GetTempPath(), "dx-award-map-" + Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".mdb");
            using (FileStream src = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (FileStream dst = new FileStream(tmp, FileMode.Create, FileAccess.Write)) src.CopyTo(dst);
            Exception last = null;
            foreach (string prov in new[] { "Microsoft.Jet.OLEDB.4.0", "Microsoft.ACE.OLEDB.12.0", "Microsoft.ACE.OLEDB.16.0" })
            {
                try
                {
                    System.Data.OleDb.OleDbConnection cn = new System.Data.OleDb.OleDbConnection("Provider=" + prov + ";Data Source=" + tmp + ";Mode=Read");
                    cn.Open(); engine = prov; return cn;
                }
                catch (Exception ex) { last = ex; }
            }
            try { File.Delete(tmp); } catch { }
            throw new Exception("Could not open the N3FJP database (" + (last != null ? last.Message : "no Access engine") + ")");
        }

        List<string> Columns(System.Data.OleDb.OleDbConnection cn)
        {
            System.Data.DataTable t = cn.GetOleDbSchemaTable(System.Data.OleDb.OleDbSchemaGuid.Columns, new object[] { null, null, "tblContacts", null });
            return t.Rows.Cast<System.Data.DataRow>().OrderBy(r => Convert.ToInt32(r["ORDINAL_POSITION"])).Select(r => (string)r["COLUMN_NAME"]).ToList();
        }

        static string S(System.Data.IDataRecord r, int i) { return r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i)).Trim(); }

        public List<object[]> ReadRows(List<string> extraFields)
        {
            string tmp; List<object[]> rows = new List<object[]>();
            using (System.Data.OleDb.OleDbConnection cn = OpenCopy(out tmp))
            {
                try
                {
                    HashSet<string> cols = new HashSet<string>(Columns(cn), StringComparer.OrdinalIgnoreCase);
                    List<string> extra = extraFields.Select(f => cols.Contains(f) ? "[" + f + "]" : "''").ToList();
                    string sql = "SELECT fldPrimaryKey, fldCall, fldDateStr, fldBand, fldMode, fldCountryDXCC, fldQSLR, fldQSLConfByR, fldOperator" +
                                 (extra.Count > 0 ? ", " + string.Join(", ", extra) : "") + " FROM tblContacts";
                    using (System.Data.OleDb.OleDbCommand cmd = new System.Data.OleDb.OleDbCommand(sql, cn))
                    using (System.Data.OleDb.OleDbDataReader rd = cmd.ExecuteReader())
                    {
                        while (rd.Read())
                        {
                            object[] row = new object[8 + extraFields.Count];
                            row[0] = rd.IsDBNull(0) ? 0 : Convert.ToInt32(rd.GetValue(0));
                            row[1] = S(rd, 1).ToUpperInvariant();
                            row[2] = S(rd, 2).Replace('/', '-');
                            row[3] = Bands.FromN3fjp(S(rd, 3));
                            row[4] = S(rd, 4).ToUpperInvariant();
                            int dx; row[5] = int.TryParse(S(rd, 5), out dx) ? dx : 0;
                            string conf = "";
                            if (S(rd, 6).ToUpperInvariant() == "Y")
                            {
                                foreach (char c in S(rd, 7).ToUpperInvariant()) if ((c == 'L' || c == 'E' || c == 'C') && conf.IndexOf(c) < 0) conf += c;
                                if (conf == "") conf = "Q"; // confirmed, method unknown
                            }
                            row[6] = conf;
                            row[7] = S(rd, 8).ToUpperInvariant();
                            for (int i = 0; i < extraFields.Count; i++) row[8 + i] = S(rd, 9 + i);
                            rows.Add(row);
                        }
                    }
                }
                finally { cn.Close(); try { File.Delete(tmp); } catch { } }
            }
            return rows;
        }

        public List<Dictionary<string, object>> FieldStats(HashSet<int> dxcc)
        {
            string tmp; List<Dictionary<string, object>> res = new List<Dictionary<string, object>>();
            Dictionary<string, string> titles = OtherTitles();
            using (System.Data.OleDb.OleDbConnection cn = OpenCopy(out tmp))
            {
                try
                {
                    string[] skip = { "fldPrimaryKey", "fldCall", "fldDateStr", "fldBand", "fldMode", "fldCountryDXCC", "fldQSLR", "fldQSLConfByR", "fldTimeOnStr", "fldTimeOffStr", "fldFrequency", "fldRstR", "fldRstS", "fldComputerName", "fldQSLS", "fldQSLConfByS", "fldGridS", "fldNameS", "fldCountyS", "fldPoints", "fldInitials", "fldFuture1", "fldFuture2" };
                    List<string> cols = Columns(cn).Where(c => !skip.Contains(c)).ToList();
                    string sql = "SELECT fldCountryDXCC, " + string.Join(", ", cols.Select(c => "[" + c + "]")) + " FROM tblContacts";
                    int[] filled = new int[cols.Count]; List<Dictionary<string, int>> samples = cols.Select(c => new Dictionary<string, int>()).ToList();
                    int total = 0;
                    using (System.Data.OleDb.OleDbCommand cmd = new System.Data.OleDb.OleDbCommand(sql, cn))
                    using (System.Data.OleDb.OleDbDataReader rd = cmd.ExecuteReader())
                    {
                        while (rd.Read())
                        {
                            int dx; int.TryParse(S(rd, 0), out dx);
                            if (dxcc != null && dxcc.Count > 0 && !dxcc.Contains(dx)) continue;
                            total++;
                            for (int i = 0; i < cols.Count; i++)
                            {
                                string v = S(rd, i + 1); if (v == "") continue;
                                filled[i]++;
                                if (v.Length > 60) v = v.Substring(0, 60);
                                Dictionary<string, int> sm = samples[i]; int n; if (sm.TryGetValue(v, out n)) sm[v] = n + 1; else if (sm.Count < 400) sm[v] = 1;
                            }
                        }
                    }
                    for (int i = 0; i < cols.Count; i++)
                    {
                        if (filled[i] == 0) continue;
                        string t; titles.TryGetValue(cols[i], out t);
                        res.Add(new Dictionary<string, object> { { "field", cols[i] }, { "title", t ?? "" }, { "filled", filled[i] }, { "total", total },
                            { "samples", samples[i].OrderByDescending(kv => kv.Value).Take(8).Select(kv => kv.Key).ToArray() } });
                    }
                }
                finally { cn.Close(); try { File.Delete(tmp); } catch { } }
            }
            return res;
        }
    }

    class AdifSource : ILogSource
    {
        readonly string path;
        public AdifSource(string p) { path = p ?? ""; }
        public string FileName { get { return Path.GetFileName(path); } }
        public string Engine { get { return "ADIF"; } }
        public string Fingerprint()
        {
            if (path == "") throw new Exception("No ADIF file chosen. Choose it in Settings.");
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) throw new Exception("ADIF file not found: " + path);
            return path + "|" + fi.LastWriteTimeUtc.Ticks + "|" + fi.Length;
        }

        // ADI reader: <NAME:LEN[:TYPE]>value ... <EOR>. Lengths are taken as bytes (as most loggers write them);
        // values are decoded as UTF-8, falling back to Windows-1252.
        public IEnumerable<Dictionary<string, string>> Records()
        {
            byte[] b;
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (MemoryStream ms = new MemoryStream()) { fs.CopyTo(ms); b = ms.ToArray(); }
            Encoding utf8 = new UTF8Encoding(false, true), ansi = Encoding.GetEncoding(1252);
            int i = 0, n = b.Length;
            // skip header if the file does not start with a tag
            if (n > 0 && b[0] != '<')
            {
                int eoh = IndexOfTag(b, "EOH", 0);
                i = eoh < 0 ? 0 : eoh;
            }
            Dictionary<string, string> rec = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            while (i < n)
            {
                int lt = Array.IndexOf(b, (byte)'<', i); if (lt < 0) break;
                int gt = Array.IndexOf(b, (byte)'>', lt); if (gt < 0) break;
                string spec = Encoding.ASCII.GetString(b, lt + 1, gt - lt - 1);
                string[] parts = spec.Split(':');
                string name = parts[0].Trim().ToUpperInvariant();
                i = gt + 1;
                if (name == "EOR") { if (rec.Count > 0) yield return rec; rec = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); continue; }
                if (name == "EOH") { rec.Clear(); continue; }
                int len; if (parts.Length < 2 || !int.TryParse(parts[1].Trim(), out len) || len < 0) continue;
                if (i + len > n) len = n - i;
                string val;
                try { val = utf8.GetString(b, i, len); } catch { val = ansi.GetString(b, i, len); }
                rec[name] = val.Trim();
                i += len;
            }
            if (rec.Count > 0) yield return rec;
        }

        static int IndexOfTag(byte[] b, string tag, int start)
        {
            string s = Encoding.ASCII.GetString(b, 0, Math.Min(b.Length, 1 << 20));
            int k = s.IndexOf("<" + tag + ">", StringComparison.OrdinalIgnoreCase);
            return k < 0 ? -1 : k + tag.Length + 2;
        }

        static string G(Dictionary<string, string> r, string k) { string v; return r.TryGetValue(k, out v) ? v : ""; }
        static bool Yes(string v) { v = (v ?? "").Trim().ToUpperInvariant(); return v == "Y" || v == "V"; }

        public List<object[]> ReadRows(List<string> extraFields)
        {
            List<object[]> rows = new List<object[]>(); int key = 0;
            foreach (Dictionary<string, string> r in Records())
            {
                object[] row = new object[8 + extraFields.Count];
                row[0] = ++key;
                row[1] = G(r, "CALL").ToUpperInvariant();
                string d = G(r, "QSO_DATE"); row[2] = d.Length == 8 ? d.Substring(0, 4) + "-" + d.Substring(4, 2) + "-" + d.Substring(6, 2) : d;
                row[3] = Bands.FromAdif(G(r, "BAND"));
                string sub = G(r, "SUBMODE"); row[4] = (sub != "" ? sub : G(r, "MODE")).ToUpperInvariant();
                int dx; row[5] = int.TryParse(G(r, "DXCC"), out dx) ? dx : 0;
                string conf = ""; if (Yes(G(r, "LOTW_QSL_RCVD"))) conf += "L"; if (Yes(G(r, "EQSL_QSL_RCVD"))) conf += "E"; if (Yes(G(r, "QSL_RCVD"))) conf += "C";
                row[6] = conf;
                string op = G(r, "OPERATOR"); if (op == "") op = G(r, "STATION_CALLSIGN"); row[7] = op.ToUpperInvariant();
                for (int i = 0; i < extraFields.Count; i++) row[8 + i] = G(r, extraFields[i]);
                rows.Add(row);
            }
            return rows;
        }

        public List<Dictionary<string, object>> FieldStats(HashSet<int> dxcc)
        {
            Dictionary<string, int> filled = new Dictionary<string, int>(); Dictionary<string, Dictionary<string, int>> samples = new Dictionary<string, Dictionary<string, int>>();
            string[] skip = { "CALL", "QSO_DATE", "TIME_ON", "TIME_OFF", "QSO_DATE_OFF", "BAND", "MODE", "SUBMODE", "DXCC", "FREQ", "FREQ_RX", "RST_SENT", "RST_RCVD", "QSL_RCVD", "QSL_SENT", "LOTW_QSL_RCVD", "LOTW_QSL_SENT", "EQSL_QSL_RCVD", "EQSL_QSL_SENT" };
            int total = 0;
            foreach (Dictionary<string, string> r in Records())
            {
                int dx; int.TryParse(G(r, "DXCC"), out dx);
                if (dxcc != null && dxcc.Count > 0 && !dxcc.Contains(dx)) continue;
                total++;
                foreach (KeyValuePair<string, string> kv in r)
                {
                    if (skip.Contains(kv.Key) || kv.Value == "") continue;
                    int c; filled.TryGetValue(kv.Key, out c); filled[kv.Key] = c + 1;
                    Dictionary<string, int> sm; if (!samples.TryGetValue(kv.Key, out sm)) samples[kv.Key] = sm = new Dictionary<string, int>();
                    string v = kv.Value.Length > 60 ? kv.Value.Substring(0, 60) : kv.Value;
                    int n; if (sm.TryGetValue(v, out n)) sm[v] = n + 1; else if (sm.Count < 400) sm[v] = 1;
                }
            }
            return filled.OrderBy(kv => kv.Key).Select(kv => new Dictionary<string, object> { { "field", kv.Key }, { "title", "" }, { "filled", kv.Value }, { "total", total },
                { "samples", samples[kv.Key].OrderByDescending(x => x.Value).Take(8).Select(x => x.Key).ToArray() } }).ToList();
        }
    }

    // ------------------------------------------------------------------ award packs (only what the server needs: which log fields to send)
    static class Packs
    {
        public static string Dir { get { return Path.Combine(App.BaseDir, "packs"); } }

        // log fields the award packs read, each with the DXCC numbers it is needed for
        // (so a long field like Comments is only sent for the countries whose award uses it)
        public static Dictionary<string, HashSet<int>> NeededFields(string sourceType)
        {
            Dictionary<string, HashSet<int>> map = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);
            if (Directory.Exists(Dir))
            {
                foreach (string pj in Directory.GetFiles(Dir, "pack.json", SearchOption.AllDirectories))
                {
                    try
                    {
                        Dictionary<string, object> p = Json.Parse(File.ReadAllText(pj)) as Dictionary<string, object>;
                        string id = Convert.ToString(p["id"]);
                        HashSet<int> dx = new HashSet<int>(((System.Collections.IEnumerable)Get(p, "dxcc")).Cast<object>().Select(o => Convert.ToInt32(o)));
                        HashSet<string> set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        object ovc; if (App.Cfg.Mapping.TryGetValue(id + "/*", out ovc)) AddList(set, ovc); else AddSources(set, Get(p, "codeSources"), sourceType);
                        object[] awards = Get(p, "awards") as object[] ?? (Get(p, "awards") is System.Collections.ArrayList ? ((System.Collections.ArrayList)Get(p, "awards")).ToArray() : new object[0]);
                        foreach (object a in awards)
                        {
                            Dictionary<string, object> ad = a as Dictionary<string, object>; if (ad == null) continue;
                            object ov; string key = id + "/" + Convert.ToString(ad["id"]);
                            if (App.Cfg.Mapping.TryGetValue(key, out ov)) AddList(set, ov);
                            else AddSources(set, Get(ad, "sources"), sourceType);
                        }
                        foreach (string f in set) { HashSet<int> h; if (!map.TryGetValue(f, out h)) map[f] = h = new HashSet<int>(); h.UnionWith(dx); }
                    }
                    catch { }
                }
            }
            return map;
        }

        static object Get(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
        static void AddSources(HashSet<string> set, object sources, string type)
        {
            Dictionary<string, object> d = sources as Dictionary<string, object>; if (d == null) return;
            object list; if (d.TryGetValue(type, out list)) AddList(set, list);
        }
        static void AddList(HashSet<string> set, object list)
        {
            System.Collections.IEnumerable e = list as System.Collections.IEnumerable; if (e == null || list is string) return;
            foreach (object o in e)
            {
                Dictionary<string, object> s = o as Dictionary<string, object>; if (s == null) continue;
                object f; if (s.TryGetValue("field", out f) && f is string && (string)f != "") set.Add((string)f);
                if (s.TryGetValue("with", out f) && f is string && (string)f != "") set.Add((string)f);
            }
        }
    }

    // ------------------------------------------------------------------ award lists (phase 7)
    // Some award lists may not be redistributed, so the program downloads them from the official sites,
    // turns them into packs\<id>\entities.json under %APPDATA%\DXAwardMap and keeps the downloaded copy.
    static class AwardLists
    {
        public static string UserPacks { get { return Path.Combine(App.StateDir, "packs"); } }
        static readonly object gate = new object();
        static readonly Dictionary<string, string> errors = new Dictionary<string, string>();
        static readonly HashSet<string> busy = new HashSet<string>();

        // entities file to serve: the downloaded one first, then the one shipped with the program
        public static string EntitiesPath(string id)
        {
            string u = Path.Combine(UserPacks, id, "entities.json"); if (File.Exists(u)) return u;
            string b = Path.Combine(Packs.Dir, id, "entities.json"); return File.Exists(b) ? b : null;
        }

        static IEnumerable<Dictionary<string, object>> ListPacks()
        {
            if (!Directory.Exists(Packs.Dir)) yield break;
            foreach (string pj in Directory.GetFiles(Packs.Dir, "pack.json", SearchOption.AllDirectories))
            {
                Dictionary<string, object> p = null;
                try { p = Json.Parse(File.ReadAllText(pj)) as Dictionary<string, object>; } catch { }
                if (p != null && p.ContainsKey("list")) yield return p;
            }
        }

        public static List<Dictionary<string, object>> Status()
        {
            List<Dictionary<string, object>> res = new List<Dictionary<string, object>>();
            foreach (Dictionary<string, object> p in ListPacks())
            {
                string id = Convert.ToString(p["id"]); Dictionary<string, object> list = (Dictionary<string, object>)p["list"];
                Dictionary<string, object> d = new Dictionary<string, object> { { "id", id }, { "name", p["name"] }, { "title", p["title"] }, { "page", list.ContainsKey("page") ? list["page"] : "" } };
                string path = EntitiesPath(id);
                d["have"] = path != null; d["downloaded"] = path != null && path.StartsWith(UserPacks, StringComparison.OrdinalIgnoreCase);
                if (path != null)
                {
                    try
                    {
                        Dictionary<string, object> e = Json.Parse(File.ReadAllText(path)) as Dictionary<string, object>;
                        object meta; if (e.TryGetValue("meta", out meta)) d["meta"] = meta;
                        d["count"] = ((System.Collections.ICollection)e["e"]).Count;
                    }
                    catch { }
                    d["fileDate"] = File.GetLastWriteTime(path).ToString("yyyy-MM-dd");
                }
                lock (gate) { string er; if (errors.TryGetValue(id, out er)) d["error"] = er; d["busy"] = busy.Contains(id); }
                res.Add(d);
            }
            return res;
        }

        // on start: download missing lists, refresh lists older than 30 days
        public static void CheckOnStart()
        {
            foreach (Dictionary<string, object> p in ListPacks())
            {
                string id = Convert.ToString(p["id"]); string u = Path.Combine(UserPacks, id, "entities.json");
                bool missing = EntitiesPath(id) == null;
                bool old = File.Exists(u) && (DateTime.Now - File.GetLastWriteTime(u)).TotalDays > 30;
                if (missing || old) { try { Update(id); } catch { } }
            }
        }

        public static void UpdateAll() { foreach (Dictionary<string, object> p in ListPacks()) { try { Update(Convert.ToString(p["id"])); } catch { } } }

        public static void Update(string id)
        {
            Dictionary<string, object> p = ListPacks().FirstOrDefault(x => Convert.ToString(x["id"]) == id);
            if (p == null) throw new Exception("Unknown award pack " + id);
            lock (gate) { if (busy.Contains(id)) return; busy.Add(id); errors.Remove(id); }
            try
            {
                Dictionary<string, object> list = (Dictionary<string, object>)p["list"];
                string dir = Path.Combine(UserPacks, id); string srcDir = Path.Combine(dir, "source");
                Directory.CreateDirectory(srcDir);
                Dictionary<string, byte[]> files = new Dictionary<string, byte[]>();
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                foreach (object fo in (System.Collections.IEnumerable)list["files"])
                {
                    Dictionary<string, object> f = (Dictionary<string, object>)fo;
                    string name = Convert.ToString(f["name"]), url = Convert.ToString(f["url"]);
                    using (WebClient wc = new WebClient())
                    {
                        wc.Headers[HttpRequestHeader.UserAgent] = "DXAwardMap/" + App.Version;
                        byte[] b = wc.DownloadData(url);
                        if (b.Length < 200) throw new Exception(name + " is too small; the site may have changed");
                        files[name] = b;
                    }
                }
                string listDate;
                List<object[]> ents = ListParsers.Parse(Convert.ToString(list["kind"]), p, files, out listDate);
                if (ents.Count < 10) throw new Exception("The downloaded list could not be read (" + ents.Count + " entries); the site format may have changed");
                foreach (KeyValuePair<string, byte[]> kv in files) File.WriteAllBytes(Path.Combine(srcDir, kv.Key), kv.Value);
                Dictionary<string, object> outp = new Dictionary<string, object> {
                    { "fields", new[] { "code", "name", "award", "region", "deletedOn", "parent", "deleted" } },
                    { "meta", new Dictionary<string, object> { { "listDate", listDate }, { "updated", DateTime.Now.ToString("yyyy-MM-dd HH:mm") }, { "source", list.ContainsKey("page") ? list["page"] : "" } } },
                    { "e", ents } };
                string tmp = Path.Combine(dir, "entities.json.tmp");
                File.WriteAllText(tmp, Json.Write(outp), new UTF8Encoding(false));
                string target = Path.Combine(dir, "entities.json");
                if (File.Exists(target)) File.Delete(target);
                File.Move(tmp, target);
            }
            catch (Exception ex)
            {
                lock (gate) errors[id] = ex.Message;
                throw;
            }
            finally { lock (gate) busy.Remove(id); }
        }
    }

    // Parsers for the official award lists. Output rows: code, name, award, region, deletedOn (yyyy-mm-dd or ""), parent, deleted (0/1).
    // They mirror tools\build-packs.ps1.
    static class ListParsers
    {
        static readonly System.Globalization.TextInfo Title = new System.Globalization.CultureInfo("en-US").TextInfo;
        static readonly string[] Months = { "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec" };
        static string Rx(string s, string pattern, int group) { System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(s, pattern); return m.Success ? m.Groups[group].Value : ""; }
        static string EngDate(string t)
        {
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(t, @"([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})\s*[,.]\s*(\d{4})");
            if (!m.Success) return "";
            int mo = Array.IndexOf(Months, m.Groups[1].Value.ToLowerInvariant()) + 1; if (mo <= 0) return "";
            return string.Format("{0}-{1:00}-{2:00}", m.Groups[3].Value, mo, int.Parse(m.Groups[2].Value));
        }
        static List<string[]> Regions(Dictionary<string, object> pack)
        {
            List<string[]> r = new List<string[]>();
            foreach (object o in (System.Collections.IEnumerable)pack["regions"]) { object[] a = ((System.Collections.IEnumerable)o).Cast<object>().ToArray(); r.Add(new[] { Convert.ToString(a[0]), Convert.ToString(a[1]) }); }
            return r;
        }
        static string[] Lines(byte[] b, Encoding enc) { return enc.GetString(b).Replace("\r", "").Split('\n'); }

        public static List<object[]> Parse(string kind, Dictionary<string, object> pack, Dictionary<string, byte[]> files, out string listDate)
        {
            switch (kind)
            {
                case "jarl": return Jarl(pack, files, out listDate);
                case "rda": return Rda(pack, files, out listDate);
                case "dok": return Dok(files, out listDate);
                case "urda": return Urda(pack, files, out listDate);
            }
            throw new Exception("Unknown list kind " + kind);
        }

        static List<object[]> Jarl(Dictionary<string, object> pack, Dictionary<string, byte[]> files, out string listDate)
        {
            List<object[]> e = new List<object[]>(); List<string> dates = new List<string>();
            foreach (string[] spec in new[] { new[] { "jcc-list.txt", "JCC" }, new[] { "jcg-list.txt", "JCG" } })
            {
                string[] lines = Lines(files[spec[0]], Encoding.ASCII);
                string asOf = EngDate(Rx(string.Join(" ", lines.Take(8)), @"as of ([^)]*)", 1)); if (asOf != "") dates.Add(spec[1] + " " + asOf);
                foreach (string line in lines)
                {
                    if (System.Text.RegularExpressions.Regex.IsMatch(line, @"^[A-Z][A-Za-z\- ]+?\s+\d{2}\s*$")) continue;
                    System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(line, @"^\s*(\*)?\s*(\d{4,6})\s+(.+?)\s*$");
                    if (!m.Success) continue;
                    string code = m.Groups[2].Value, rest = m.Groups[3].Value, d = "";
                    System.Text.RegularExpressions.Match q = System.Text.RegularExpressions.Regex.Match(rest, "^(.*?)\\s*\"([^\"]*)\"\\s*$");
                    if (q.Success) { rest = q.Groups[1].Value.Trim(); d = EngDate(q.Groups[2].Value); }
                    e.Add(new object[] { code, rest, spec[1], code.Substring(0, 2), d, "", m.Groups[1].Success ? 1 : 0 });
                }
            }
            string parent = "";
            string[] ku = Lines(files["ku-list.txt"], Encoding.GetEncoding(932));
            string kuDate = Rx(ku.Length > 0 ? ku[0] : "", @"(\d{4})年(\d{1,2})月(\d{1,2})日", 0);
            if (kuDate != "") { System.Text.RegularExpressions.Match km = System.Text.RegularExpressions.Regex.Match(kuDate, @"(\d{4})年(\d{1,2})月(\d{1,2})日"); dates.Add(string.Format("KU {0}-{1:00}-{2:00}", km.Groups[1].Value, int.Parse(km.Groups[2].Value), int.Parse(km.Groups[3].Value))); }
            foreach (string raw in ku)
            {
                string line = raw.TrimEnd();
                System.Text.RegularExpressions.Match h = System.Text.RegularExpressions.Regex.Match(line, @"^(\S+)[(（](\d{4})[)）]\s*$");
                if (h.Success) { parent = h.Groups[2].Value; continue; }
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(line, @"^(\d{6})(※)?\s*(\S+)\s+(\S+)\s*(.*)$");
                if (!m.Success) continue;
                string d = "";
                if (m.Groups[2].Success && m.Groups[2].Value != "")
                {
                    System.Text.RegularExpressions.Match dm = System.Text.RegularExpressions.Regex.Match(m.Groups[5].Value, @"(\d{4})(?:\([^)]*\))?年(\d{1,2})月(\d{1,2})日");
                    if (dm.Success) d = string.Format("{0}-{1:00}-{2:00}", dm.Groups[1].Value, int.Parse(dm.Groups[2].Value), int.Parse(dm.Groups[3].Value));
                }
                e.Add(new object[] { m.Groups[1].Value, m.Groups[3].Value, "KU", m.Groups[1].Value.Substring(0, 2), d, parent, d != "" ? 1 : 0 });
            }
            foreach (string[] r in Regions(pack)) e.Add(new object[] { r[0], r[1], "WAJA", r[0], "", "", 0 });
            listDate = string.Join(", ", dates);
            return e;
        }

        static List<object[]> Rda(Dictionary<string, object> pack, Dictionary<string, byte[]> files, out string listDate)
        {
            string[] lines = Lines(files["rda_eng.txt"], Encoding.GetEncoding(1252));
            listDate = Rx(string.Join(" ", lines.Take(10)), @"Last update ([0-9.]+)", 1);
            List<object[]> e = new List<object[]>();
            foreach (string line in lines)
            {
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(line, @"^([A-Z]{2}-\d{2})\t(.*)$");
                if (!m.Success) continue;
                string[] parts = m.Groups[2].Value.Split('\t').Select(x => x.Trim()).Where(x => x != "").ToArray();
                string name = parts.Length > 0 ? parts[0] : ""; bool del = name.StartsWith("deleted", StringComparison.OrdinalIgnoreCase);
                if (del) { string repl = parts.Length > 1 ? parts[parts.Length - 1] : ""; name = repl != "" && repl != "deleted" && repl != "***" ? "deleted (now " + repl + ")" : "deleted"; }
                e.Add(new object[] { m.Groups[1].Value, Title.ToTitleCase(name.ToLowerInvariant()), "RDA", m.Groups[1].Value.Substring(0, 2), "", "", del ? 1 : 0 });
            }
            foreach (string[] r in Regions(pack))
            {
                bool anyCurrent = e.Any(x => (string)x[2] == "RDA" && (string)x[3] == r[0] && (int)x[6] == 0);
                e.Add(new object[] { r[0], r[1], "OBL", r[0], "", "", anyCurrent ? 0 : 1 });
            }
            return e;
        }

        static List<object[]> Dok(Dictionary<string, byte[]> files, out string listDate)
        {
            List<object[]> e = new List<object[]>();
            foreach (string line in Lines(files["dok.csv"], Encoding.UTF8))
            {
                string[] p = line.Split(';'); if (p.Length < 3 || !System.Text.RegularExpressions.Regex.IsMatch(p[0], @"^[A-Z]\d{2}$")) continue;
                e.Add(new object[] { p[0], p[2], "DOK", p[0].Substring(0, 1), "", "", 0 });
            }
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); string today = DateTime.Now.ToString("yyyy-MM-dd");
            foreach (string line in Lines(files["sdok.csv"], Encoding.UTF8))
            {
                string[] p = line.Split(';'); if (p.Length < 5 || !seen.Add(p[0])) continue;
                string end = ""; System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(p[4], @"^(\d{2})\.(\d{2})\.(\d{2,4})$");
                if (m.Success) { int y = int.Parse(m.Groups[3].Value); if (y < 100) y += y > 50 ? 1900 : 2000; end = string.Format("{0}-{1}-{2}", y, m.Groups[2].Value, m.Groups[1].Value); }
                e.Add(new object[] { p[0].ToUpperInvariant(), p[1], "SDOK", "S", end, "", end != "" && string.CompareOrdinal(end, today) < 0 ? 1 : 0 });
            }
            listDate = "downloaded " + DateTime.Now.ToString("yyyy-MM-dd");
            return e;
        }

        static List<object[]> Urda(Dictionary<string, object> pack, Dictionary<string, byte[]> files, out string listDate)
        {
            byte[] b = files["listeng.htm"];
            string html;
            try { html = new UTF8Encoding(false, true).GetString(b); } catch { html = Encoding.GetEncoding(1251).GetString(b); }
            string t = System.Text.RegularExpressions.Regex.Replace(html, @"(?i)<br\s*/?>|</tr>|</p>|</td>", "\n");
            t = WebUtility.HtmlDecode(System.Text.RegularExpressions.Regex.Replace(t, "<[^>]+>", ""));
            string flat = System.Text.RegularExpressions.Regex.Replace(t, @"\s+", "");
            System.Text.RegularExpressions.Match dm = System.Text.RegularExpressions.Regex.Match(flat, @"(?i)stand(\d{1,2})([a-z]+)(\d{4})");
            listDate = dm.Success ? dm.Groups[1].Value + " " + dm.Groups[2].Value + " " + dm.Groups[3].Value : "";
            Dictionary<char, char> cyr = new Dictionary<char, char> { { 'А', 'A' }, { 'В', 'B' }, { 'С', 'C' }, { 'Е', 'E' }, { 'Н', 'H' }, { 'І', 'I' }, { 'К', 'K' }, { 'М', 'M' }, { 'О', 'O' }, { 'Р', 'P' }, { 'Т', 'T' }, { 'Х', 'X' } };
            List<object[]> e = new List<object[]>();
            foreach (string raw in t.Split('\n'))
            {
                string line = System.Text.RegularExpressions.Regex.Replace(raw, @"\s+", " ").Trim(); if (line == "") continue;
                string head = new string(line.Select(c => cyr.ContainsKey(c) ? cyr[c] : c).ToArray());
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(head, @"^([A-Z]{2})-(\d{2})\b\s*(.*)$");
                if (!m.Success) continue;
                string name = m.Groups[3].Value;
                name = System.Text.RegularExpressions.Regex.Replace(name, @"^\d{5}\s*-\s*\d{5}\s*", "");
                name = System.Text.RegularExpressions.Regex.Replace(name, @"^\d{5}\s*-\s*", "");
                name = System.Text.RegularExpressions.Regex.Replace(name, @"[\p{IsCyrillic}][^.]*\.\s*", "");
                name = System.Text.RegularExpressions.Regex.Replace(name, @"\(Up [^)]*\)", "").Trim();
                e.Add(new object[] { m.Groups[1].Value + "-" + m.Groups[2].Value, name, "URDA", m.Groups[1].Value, "", "", 0 });
            }
            foreach (string[] r in Regions(pack)) e.Add(new object[] { r[0], r[1], "OBL", r[0], "", "", 0 });
            return e;
        }
    }

    // ------------------------------------------------------------------ local web server
    class WebServer
    {
        HttpListener listener;
        public int Port;
        readonly Dictionary<string, object> statsCache = new Dictionary<string, object>();

        public void Start(int preferred)
        {
            Exception last = null;
            for (int p = preferred; p < preferred + 20; p++)
            {
                try { HttpListener l = new HttpListener(); l.Prefixes.Add("http://localhost:" + p + "/"); l.Start(); listener = l; Port = p; break; }
                catch (Exception ex) { last = ex; }
            }
            if (listener == null) throw last ?? new Exception("no free port");
            File.WriteAllText(Path.Combine(App.StateDir, "port.txt"), Port.ToString());
            Thread t = new Thread(delegate ()
            {
                while (listener.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = listener.GetContext(); } catch { break; }
                    ThreadPool.QueueUserWorkItem(Handle, ctx);
                }
            });
            t.IsBackground = true; t.Start();
        }

        public void Stop() { try { listener.Stop(); } catch { } }

        void Handle(object state)
        {
            HttpListenerContext ctx = (HttpListenerContext)state;
            try
            {
                string p = ctx.Request.Url.AbsolutePath;
                ctx.Response.Headers["Cache-Control"] = "no-store";
                // only answer requests addressed to localhost (blocks DNS-rebinding style access from web pages)
                string host = (ctx.Request.Headers["Host"] ?? "").Split(':')[0];
                if (host != "localhost" && host != "127.0.0.1") { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }

                if (p == "/" || p == "/index.html") { SendFile(ctx, Path.Combine(App.BaseDir, "web", "index.html")); return; }
                if (p == "/api/version") { Send(ctx, App.Store.Version, "text/plain"); return; }
                if (p == "/api/data") { Send(ctx, App.Store.Json, "application/json"); return; }
                if (p == "/api/status") { Send(ctx, Json.Write(Status()), "application/json"); return; }
                if (p == "/api/settings" && ctx.Request.HttpMethod == "GET") { Send(ctx, Json.Write(App.Cfg.ToDict()), "application/json"); return; }
                if (p == "/api/settings" && ctx.Request.HttpMethod == "POST") { SaveSettings(ctx); return; }
                if (p == "/api/fields") { Fields(ctx); return; }
                if (p == "/api/pick") { Pick(ctx); return; }
                if (p == "/api/reload" && ctx.Request.HttpMethod == "POST") { ThreadPool.QueueUserWorkItem(delegate { App.Store.Reload(true); }); Send(ctx, "{\"ok\":true}", "application/json"); return; }
                if (p == "/api/lists") { Send(ctx, Json.Write(AwardLists.Status()), "application/json"); return; }
                if (p == "/api/lists/update" && ctx.Request.HttpMethod == "POST")
                {
                    string id = ctx.Request.QueryString["id"] ?? "";
                    ThreadPool.QueueUserWorkItem(delegate { try { if (id == "") AwardLists.UpdateAll(); else AwardLists.Update(id); } catch { } });
                    Send(ctx, "{\"ok\":true}", "application/json"); return;
                }
                System.Text.RegularExpressions.Match em = System.Text.RegularExpressions.Regex.Match(p, @"^/packs/([a-z0-9-]+)/entities\.json$");
                if (em.Success)
                {
                    string ef = AwardLists.EntitiesPath(em.Groups[1].Value);
                    if (ef != null) SendFile(ctx, ef); else { ctx.Response.StatusCode = 404; ctx.Response.Close(); }
                    return;
                }
                foreach (string dir in new[] { "web", "data", "packs" })
                {
                    if (!p.StartsWith("/" + dir + "/")) continue;
                    string root = Path.GetFullPath(Path.Combine(App.BaseDir, dir)) + Path.DirectorySeparatorChar;
                    string f = Path.GetFullPath(Path.Combine(App.BaseDir, Uri.UnescapeDataString(p.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar)));
                    if (f.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(f)) { SendFile(ctx, f); return; }
                }
                ctx.Response.StatusCode = 404; ctx.Response.Close();
            }
            catch (Exception ex)
            {
                try { ctx.Response.StatusCode = 500; Send(ctx, Json.Write(new Dictionary<string, object> { { "error", ex.Message } }), "application/json"); } catch { }
            }
        }

        Dictionary<string, object> Status()
        {
            LogStore s = App.Store;
            Dictionary<string, object> d = new Dictionary<string, object> {
                { "app", App.Version }, { "project", App.ProjectUrl }, { "status", s.Status }, { "error", s.Error }, { "file", s.FileName }, { "count", s.Count }, { "engine", s.Engine },
                { "version", s.Version }, { "source", App.Cfg.Source }, { "configured", App.Cfg.IsConfigured }, { "fields", s.ExtraFields.ToArray() } };
            try { d["n3fjpActive"] = N3fjpSource.FindActiveLog(); } catch { d["n3fjpActive"] = ""; }
            return d;
        }

        void SaveSettings(HttpListenerContext ctx)
        {
            string body; using (StreamReader r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = r.ReadToEnd();
            Dictionary<string, object> d = Json.Parse(body) as Dictionary<string, object>;
            if (d == null) throw new Exception("Invalid settings");
            App.Cfg.FromDict(d);
            App.Cfg.Save();
            lock (statsCache) statsCache.Clear();
            ThreadPool.QueueUserWorkItem(delegate { App.Store.Reload(true); });
            Send(ctx, Json.Write(App.Cfg.ToDict()), "application/json");
        }

        // which log fields exist and how they are filled (for the field-mapping screen)
        void Fields(HttpListenerContext ctx)
        {
            string q = ctx.Request.QueryString["dxcc"] ?? "";
            HashSet<int> dx = new HashSet<int>(q.Split(',').Select(s => { int v; return int.TryParse(s, out v) ? v : -1; }).Where(v => v > 0));
            string key = App.Cfg.Source + "|" + App.Store.Version + "|" + q;
            object cached; lock (statsCache) statsCache.TryGetValue(key, out cached);
            if (cached == null)
            {
                cached = App.Store.CreateSource().FieldStats(dx);
                lock (statsCache) statsCache[key] = cached;
            }
            Send(ctx, Json.Write(cached), "application/json");
        }

        // native file dialog, shown by the tray program on the user's desktop
        void Pick(HttpListenerContext ctx)
        {
            string kind = ctx.Request.QueryString["kind"] ?? "mdb";
            string result = "";
            App.Ui.Invoke((MethodInvoker)delegate
            {
                using (OpenFileDialog dlg = new OpenFileDialog())
                {
                    dlg.Title = kind == "adif" ? "Choose your ADIF log file" : "Choose your N3FJP log database";
                    dlg.Filter = kind == "adif" ? "ADIF files (*.adi;*.adif)|*.adi;*.adif|All files (*.*)|*.*" : "N3FJP log (*.mdb)|*.mdb|All files (*.*)|*.*";
                    if (kind != "adif") { try { dlg.InitialDirectory = Path.GetDirectoryName(N3fjpSource.FindActiveLog()); } catch { } }
                    App.Ui.TopMost = true; App.Ui.Activate();
                    if (dlg.ShowDialog(App.Ui) == DialogResult.OK) result = dlg.FileName;
                    App.Ui.TopMost = false;
                }
            });
            Send(ctx, Json.Write(new Dictionary<string, object> { { "path", result } }), "application/json");
        }

        static void Send(HttpListenerContext ctx, string text, string type) { SendBytes(ctx, Encoding.UTF8.GetBytes(text), type + "; charset=utf-8"); }
        static void SendBytes(HttpListenerContext ctx, byte[] body, string type)
        {
            ctx.Response.ContentType = type; ctx.Response.ContentLength64 = body.Length;
            ctx.Response.OutputStream.Write(body, 0, body.Length); ctx.Response.Close();
        }
        static void SendFile(HttpListenerContext ctx, string f)
        {
            string ext = Path.GetExtension(f).ToLowerInvariant();
            string type = ext == ".html" ? "text/html; charset=utf-8" : ext == ".js" ? "text/javascript; charset=utf-8" : ext == ".css" ? "text/css; charset=utf-8" : ext == ".json" ? "application/json; charset=utf-8" : ext == ".svg" ? "image/svg+xml" : ext == ".png" ? "image/png" : "application/octet-stream";
            SendBytes(ctx, File.ReadAllBytes(f), type);
        }
    }

    // ------------------------------------------------------------------ helpers
    static class Json
    {
        static JavaScriptSerializer Ser() { JavaScriptSerializer s = new JavaScriptSerializer(); s.MaxJsonLength = int.MaxValue; s.RecursionLimit = 200; return s; }
        public static string Write(object o) { return Ser().Serialize(o); }
        public static object Parse(string s) { return Ser().DeserializeObject(s); }
    }

    static class Util
    {
        public static string ReadText(string f) { try { return File.ReadAllText(f).Trim(); } catch { return ""; } }

        public static string Hash(string s)
        {
            using (SHA1 sha = SHA1.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(s)), 0, 8).Replace("-", "").ToLowerInvariant();
        }

        public static void OpenWindow(int port, string hash = "")
        {
            string url = "http://localhost:" + port + "/" + hash;
            string[] edges = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe") };
            foreach (string e in edges) if (File.Exists(e)) { Process.Start(e, "--app=" + url + " --window-size=1600,1000"); return; }
            Process.Start(url);
        }

        public static Icon MakeIcon()
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                using (SolidBrush b = new SolidBrush(Color.FromArgb(42, 120, 214))) g.FillEllipse(b, 1, 1, 30, 30);
                using (Pen pen = new Pen(Color.FromArgb(180, 255, 255, 255), 1.5f)) { g.DrawEllipse(pen, 8, 3, 16, 26); g.DrawLine(pen, 2, 16, 30, 16); }
                using (Font f = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    g.DrawString("DX", f, Brushes.White, new RectangleF(0, 0, 32, 32), sf);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }
}
