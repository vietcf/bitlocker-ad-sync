using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace BitlockerSync.Worker.Security;

/// <summary>
/// Secrets in appsettings.json may be stored as "dpapi:&lt;base64&gt;", encrypted with Windows DPAPI
/// for the local machine: only processes on this server can decrypt them, and the file alone is
/// useless elsewhere. Produce the value with: BitlockerSync.Worker protect "&lt;secret&gt;".
/// </summary>
public static class SecretProtector
{
    private const string Prefix = "dpapi:";
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BitlockerSync.Worker/v1");

    [SupportedOSPlatform("windows")]
    public static string Protect(string secret) =>
        Prefix + Convert.ToBase64String(
            ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), Entropy, DataProtectionScope.LocalMachine));

    /// <summary>Returns the secret in clear: decrypts "dpapi:" values, returns others unchanged.</summary>
    public static string? Reveal(string? value)
    {
        if (value is null || !value.StartsWith(Prefix, StringComparison.Ordinal)) return value;
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("dpapi: secrets can only be read on Windows.");
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(value[Prefix.Length..]), Entropy, DataProtectionScope.LocalMachine);
        return Encoding.UTF8.GetString(bytes);
    }
}
