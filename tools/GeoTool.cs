// Geometry helpers for the build tools (compiled on the fly with Add-Type in PowerShell 7).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

public class GeoFeature
{
    public Dictionary<string, string> Props = new Dictionary<string, string>();
    // polygons -> rings -> points (x, y)
    public List<List<List<double[]>>> Polys = new List<List<List<double[]>>>();
    public double[] BBox;
    public string Prop(string k) { string v; return Props.TryGetValue(k, out v) ? v : ""; }
}

public static class GeoTool
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static List<GeoFeature> LoadGeoJson(string path)
    {
        var list = new List<GeoFeature>();
        using (var fs = File.OpenRead(path))
        using (var doc = JsonDocument.Parse(fs))
        {
            foreach (var f in doc.RootElement.GetProperty("features").EnumerateArray())
            {
                var gf = new GeoFeature();
                if (f.TryGetProperty("properties", out var props) && props.ValueKind == JsonValueKind.Object)
                    foreach (var p in props.EnumerateObject())
                        gf.Props[p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.ToString();
                var g = f.GetProperty("geometry");
                if (g.ValueKind != JsonValueKind.Object) continue;
                string type = g.GetProperty("type").GetString();
                var c = g.GetProperty("coordinates");
                if (type == "Polygon") gf.Polys.Add(ReadPoly(c));
                else if (type == "MultiPolygon") foreach (var p in c.EnumerateArray()) gf.Polys.Add(ReadPoly(p));
                else continue;
                gf.BBox = ComputeBBox(gf.Polys);
                list.Add(gf);
            }
        }
        return list;
    }

    // TopoJSON reader for one object (enough for us-atlas): decodes arcs into GeoFeatures.
    public static List<GeoFeature> LoadTopoJson(string path, string objectName)
    {
        var list = new List<GeoFeature>();
        using (var fs = File.OpenRead(path))
        using (var doc = JsonDocument.Parse(fs))
        {
            var root = doc.RootElement;
            double sx = 1, sy = 1, tx = 0, ty = 0;
            if (root.TryGetProperty("transform", out var tr))
            {
                sx = tr.GetProperty("scale")[0].GetDouble(); sy = tr.GetProperty("scale")[1].GetDouble();
                tx = tr.GetProperty("translate")[0].GetDouble(); ty = tr.GetProperty("translate")[1].GetDouble();
            }
            var arcs = new List<List<double[]>>();
            foreach (var a in root.GetProperty("arcs").EnumerateArray())
            {
                var pts = new List<double[]>(); double x = 0, y = 0;
                foreach (var p in a.EnumerateArray()) { x += p[0].GetDouble(); y += p[1].GetDouble(); pts.Add(new[] { x * sx + tx, y * sy + ty }); }
                arcs.Add(pts);
            }
            Func<JsonElement, List<double[]>> ring = r =>
            {
                var pts = new List<double[]>();
                foreach (var ai in r.EnumerateArray())
                {
                    int i = ai.GetInt32(); var arc = i >= 0 ? arcs[i] : Enumerable.Reverse(arcs[~i]).ToList();
                    for (int k = pts.Count == 0 ? 0 : 1; k < arc.Count; k++) pts.Add(arc[k]);
                }
                return pts;
            };
            foreach (var g in root.GetProperty("objects").GetProperty(objectName).GetProperty("geometries").EnumerateArray())
            {
                var gf = new GeoFeature();
                if (g.TryGetProperty("id", out var id)) gf.Props["id"] = id.ValueKind == JsonValueKind.String ? id.GetString() : id.ToString();
                if (g.TryGetProperty("properties", out var props)) foreach (var p in props.EnumerateObject()) gf.Props[p.Name] = p.Value.ToString();
                if (!g.TryGetProperty("type", out var tp)) continue;
                string type = tp.GetString();
                if (type == "Polygon") gf.Polys.Add(g.GetProperty("arcs").EnumerateArray().Select(ring).ToList());
                else if (type == "MultiPolygon") foreach (var p in g.GetProperty("arcs").EnumerateArray()) gf.Polys.Add(p.EnumerateArray().Select(ring).ToList());
                else continue;
                gf.BBox = ComputeBBox(gf.Polys);
                list.Add(gf);
            }
        }
        return list;
    }

    static List<List<double[]>> ReadPoly(JsonElement p)
    {
        var rings = new List<List<double[]>>();
        foreach (var r in p.EnumerateArray())
        {
            var pts = new List<double[]>();
            foreach (var pt in r.EnumerateArray()) pts.Add(new[] { pt[0].GetDouble(), pt[1].GetDouble() });
            rings.Add(pts);
        }
        return rings;
    }

    static double[] ComputeBBox(List<List<List<double[]>>> polys)
    {
        double a = 999, b = 999, c = -999, d = -999;
        foreach (var p in polys) foreach (var pt in p[0]) { a = Math.Min(a, pt[0]); b = Math.Min(b, pt[1]); c = Math.Max(c, pt[0]); d = Math.Max(d, pt[1]); }
        return new[] { a, b, c, d };
    }

    // round to `digits`, drop repeated points, drop rings with fewer than 4 points (keeps the largest polygon at least)
    public static void Simplify(GeoFeature f, int digits)
    {
        var outPolys = new List<List<List<double[]>>>();
        foreach (var p in f.Polys)
        {
            var rings = new List<List<double[]>>();
            foreach (var r in p)
            {
                var pts = new List<double[]>(); double px = double.NaN, py = double.NaN;
                foreach (var pt in r)
                {
                    double x = Math.Round(pt[0], digits), y = Math.Round(pt[1], digits);
                    if (x != px || y != py) { pts.Add(new[] { x, y }); px = x; py = y; }
                }
                if (pts.Count >= 4) rings.Add(pts);
                else if (rings.Count == 0) { rings = null; break; } // outer ring vanished: drop polygon
            }
            if (rings != null && rings.Count > 0) outPolys.Add(rings);
        }
        if (outPolys.Count == 0 && f.Polys.Count > 0)
        {   // keep a tiny triangle so very small islands stay clickable
            var c = Centroid(f);
            double e = Math.Pow(10, -digits);
            outPolys.Add(new List<List<double[]>> { new List<double[]> { new[] { c[0] - e, c[1] - e }, new[] { c[0] + e, c[1] - e }, new[] { c[0], c[1] + e }, new[] { c[0] - e, c[1] - e } } });
        }
        f.Polys = outPolys;
        f.BBox = ComputeBBox(f.Polys);
    }

    static bool InRing(List<double[]> r, double x, double y)
    {
        bool inside = false;
        for (int i = 0, j = r.Count - 1; i < r.Count; j = i++)
        {
            double xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
            if (((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    public static bool Contains(GeoFeature f, double x, double y)
    {
        if (x < f.BBox[0] || x > f.BBox[2] || y < f.BBox[1] || y > f.BBox[3]) return false;
        foreach (var p in f.Polys)
        {
            if (!InRing(p[0], x, y)) continue;
            bool hole = false; for (int k = 1; k < p.Count; k++) if (InRing(p[k], x, y)) hole = true;
            if (!hole) return true;
        }
        return false;
    }

    // centroid of the largest outer ring
    public static double[] Centroid(GeoFeature f)
    {
        double best = 0; double[] res = null;
        foreach (var p in f.Polys)
        {
            var r = p[0]; double a = 0, cx = 0, cy = 0;
            for (int i = 0; i < r.Count - 1; i++) { double t = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; a += t; cx += (r[i][0] + r[i + 1][0]) * t; cy += (r[i][1] + r[i + 1][1]) * t; }
            if (Math.Abs(a) > best && a != 0) { best = Math.Abs(a); res = new[] { cx / (3 * a), cy / (3 * a) }; }
        }
        if (res == null && f.Polys.Count > 0) res = f.Polys[0][0][0];
        return res;
    }

    public static double Area(GeoFeature f)
    {
        double s = 0;
        foreach (var p in f.Polys) { var r = p[0]; double a = 0; for (int i = 0; i < r.Count - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; s += Math.Abs(a) / 2; }
        return s;
    }

    // GeoJSON geometry text
    public static string GeometryJson(GeoFeature f)
    {
        var sb = new StringBuilder();
        Action<List<List<double[]>>> poly = p =>
        {
            sb.Append('[');
            for (int r = 0; r < p.Count; r++)
            {
                if (r > 0) sb.Append(','); sb.Append('[');
                for (int i = 0; i < p[r].Count; i++) { if (i > 0) sb.Append(','); sb.Append('[').Append(p[r][i][0].ToString("R", Inv)).Append(',').Append(p[r][i][1].ToString("R", Inv)).Append(']'); }
                sb.Append(']');
            }
            sb.Append(']');
        };
        if (f.Polys.Count == 1) { sb.Append("{\"type\":\"Polygon\",\"coordinates\":"); poly(f.Polys[0]); }
        else { sb.Append("{\"type\":\"MultiPolygon\",\"coordinates\":["); for (int i = 0; i < f.Polys.Count; i++) { if (i > 0) sb.Append(','); poly(f.Polys[i]); } sb.Append(']'); }
        sb.Append('}');
        return sb.ToString();
    }

    // FeatureCollection text; props is a JSON object string per feature
    public static void WriteFeatureCollection(string path, List<GeoFeature> feats, List<string> props)
    {
        var sb = new StringBuilder("{\"type\":\"FeatureCollection\",\"features\":[");
        for (int i = 0; i < feats.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"type\":\"Feature\",\"properties\":").Append(props[i]).Append(",\"geometry\":").Append(GeometryJson(feats[i])).Append('}');
        }
        sb.Append("]}");
        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
    }

    public static GeoFeature Merge(IEnumerable<GeoFeature> parts)
    {
        var g = new GeoFeature();
        foreach (var p in parts) g.Polys.AddRange(p.Polys);
        g.BBox = ComputeBBox(g.Polys);
        return g;
    }
}
