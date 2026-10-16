using System.Globalization;

namespace BitlockerSync.Worker.Directory;

/// <summary>Parsing helpers for values as Active Directory returns them.</summary>
public static class LdapValues
{
    private static readonly string[] GeneralizedTimeFormats =
    [
        "yyyyMMddHHmmss.0'Z'",
        "yyyyMMddHHmmss.f'Z'",
        "yyyyMMddHHmmss'Z'",
    ];

    /// <summary>"20261012081355.0Z" (AD Generalized Time, UTC) -> DateTimeOffset.</summary>
    public static DateTimeOffset? ParseGeneralizedTime(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return DateTimeOffset.TryParseExact(value, GeneralizedTimeFormats, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var t)
            ? t
            : null;
    }

    /// <summary>"OU=A, OU=B,DC=x" -> "ou=a,ou=b,dc=x": lower case, no spaces around commas or '='.</summary>
    public static string NormalizeDn(string dn) =>
        string.Join(',', dn.Split(',').Select(rdn => string.Join('=', rdn.Split('=').Select(p => p.Trim())).ToLowerInvariant()));

    /// <summary>
    /// The OUs to read, in the configured order: duplicates dropped, and an OU that sits inside
    /// another listed OU dropped too (the subtree search of the outer one already covers it), so
    /// no object is read twice. Empty list = the whole domain (<paramref name="baseDn"/>).
    /// </summary>
    public static IReadOnlyList<string> EffectiveSearchBases(IEnumerable<string> searchBases, string baseDn)
    {
        var bases = searchBases.Where(b => !string.IsNullOrWhiteSpace(b)).Select(b => b.Trim()).ToList();
        if (bases.Count == 0) return [baseDn];
        var normalized = bases.Select(NormalizeDn).ToList();
        var result = new List<string>();
        var kept = new HashSet<string>();
        for (var i = 0; i < bases.Count; i++)
        {
            var n = normalized[i];
            if (!kept.Add(n)) continue; // duplicate
            if (normalized.Where((other, j) => j != i && other != n).Any(other => n.EndsWith("," + other))) continue; // nested
            result.Add(bases[i]);
        }
        return result;
    }

    /// <summary>True when <paramref name="dn"/> is <paramref name="baseDn"/> or inside it.</summary>
    public static bool IsWithin(string dn, string baseDn)
    {
        var d = NormalizeDn(dn);
        var b = NormalizeDn(baseDn);
        return d == b || d.EndsWith("," + b);
    }

    /// <summary>
    /// AD binary GUIDs (objectGUID, msFVE-RecoveryGuid, msFVE-VolumeGuid) use the same byte order as
    /// <see cref="Guid(byte[])"/>, so the constructor gives the usual text form directly.
    /// </summary>
    public static Guid ParseGuid(byte[] bytes) =>
        bytes.Length == 16 ? new Guid(bytes) : throw new FormatException($"Expected 16 bytes, got {bytes.Length}.");

    /// <summary>The DN of the parent object: drops the first RDN, respecting escaped commas ("\,").</summary>
    public static string ParentDn(string dn)
    {
        for (var i = 0; i < dn.Length; i++)
        {
            if (dn[i] == '\\') { i++; continue; }
            if (dn[i] == ',') return dn[(i + 1)..].TrimStart();
        }
        return "";
    }

    /// <summary>Escapes a value for use inside an LDAP filter (RFC 4515).</summary>
    public static string EscapeFilterValue(string value)
    {
        var sb = new System.Text.StringBuilder(value.Length);
        foreach (var c in value)
        {
            sb.Append(c switch
            {
                '\\' => @"\5c",
                '*' => @"\2a",
                '(' => @"\28",
                ')' => @"\29",
                '\0' => @"\00",
                _ => c.ToString(),
            });
        }
        return sb.ToString();
    }
}
