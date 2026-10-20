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

    /// <summary>AD large integer date (lastLogonTimestamp: 100 ns ticks since 1601-01-01 UTC). 0 or Int64.MaxValue = no value.</summary>
    public static DateTimeOffset? ParseFileTime(string? value)
    {
        if (!long.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var ticks)) return null;
        if (ticks <= 0 || ticks == long.MaxValue) return null;
        try { return DateTimeOffset.FromFileTime(ticks).ToUniversalTime(); }
        catch (ArgumentOutOfRangeException) { return null; }
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

    /// <summary>Trims the operating-system patterns, drops empty ones and duplicates (case-insensitive).</summary>
    public static IReadOnlyList<string> CleanOsPatterns(IEnumerable<string>? patterns) =>
        (patterns ?? []).Select(p => p?.Trim() ?? "").Where(p => p.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>Escapes a filter value but keeps "*" as the wildcard ("Windows Server*").</summary>
    public static string EscapeFilterPattern(string pattern) =>
        string.Join("*", pattern.Split('*').Select(EscapeFilterValue));

    /// <summary>
    /// Computer objects, leaving out those whose operatingSystem matches a pattern. A computer with no
    /// operatingSystem is kept. No patterns: every computer.
    /// </summary>
    public static string ComputerFilter(IEnumerable<string>? excludeOs)
    {
        var patterns = CleanOsPatterns(excludeOs);
        return patterns.Count == 0
            ? "(objectCategory=computer)"
            : "(&(objectCategory=computer)" + string.Concat(patterns.Select(p => $"(!(operatingSystem={EscapeFilterPattern(p)}))")) + ")";
    }

    /// <summary>The computers <see cref="ComputerFilter"/> leaves out (used to drop their recovery keys).</summary>
    public static string ExcludedComputerFilter(IEnumerable<string>? excludeOs) =>
        "(&(objectCategory=computer)(|" + string.Concat(CleanOsPatterns(excludeOs).Select(p => $"(operatingSystem={EscapeFilterPattern(p)})")) + "))";

    /// <summary>A recovery object is a child of its computer: true when that computer is in the excluded set (DNs in lower case).</summary>
    public static bool IsKeyOfExcluded(ISet<string>? excluded, string keyDn) =>
        excluded is { Count: > 0 } && excluded.Contains(ParentDn(keyDn).ToLowerInvariant());

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
