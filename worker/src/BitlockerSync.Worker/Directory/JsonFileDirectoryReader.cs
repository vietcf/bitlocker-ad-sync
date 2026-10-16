using System.Text.Json;
using BitlockerSync.Worker.Options;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Directory;

/// <summary>
/// Development stand-in for Active Directory: reads computers and keys from a JSON file, so the
/// whole pipeline can run against the API without a domain controller. Never use in production.
/// File: { "dc": { dnsHostName, highestCommittedUsn, invocationId }, "computers": [AdComputer], "keys": [AdRecoveryKey] }
/// </summary>
public sealed class JsonFileDirectoryReaderFactory(IOptions<LdapOptions> options) : IDirectoryReaderFactory
{
    public string PreferredServer => "json-file";

    public IDirectoryReader Create() => new JsonFileDirectoryReader(Path.GetFullPath(options.Value.JsonFilePath, AppContext.BaseDirectory));
}

public sealed class JsonFileDirectoryReader(string path) : IDirectoryReader
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private FileData? _data;

    private sealed record FileData(DcInfo Dc, List<AdComputer> Computers, List<AdRecoveryKey> Keys);

    private FileData Data => _data ?? throw new InvalidOperationException("Call ConnectAsync first.");

    public async Task<DcInfo> ConnectAsync(CancellationToken ct)
    {
        if (!File.Exists(path)) throw new DirectoryException(DirectoryErrorKind.Unreachable, $"Sample directory file not found: {path}");
        await using var stream = File.OpenRead(path);
        _data = await JsonSerializer.DeserializeAsync<FileData>(stream, Json, ct)
                ?? throw new DirectoryException(DirectoryErrorKind.Other, $"Empty sample directory file: {path}");
        return Data.Dc;
    }

    public DcInfo ReadDcInfo() => Data.Dc;

    public IEnumerable<AdComputer> ReadComputers(long? sinceUsn, CancellationToken ct) =>
        Data.Computers.Where(c => sinceUsn is null || c.UsnChanged > sinceUsn);

    public IEnumerable<AdRecoveryKey> ReadRecoveryKeys(long? sinceUsn, CancellationToken ct) =>
        Data.Keys.Where(k => sinceUsn is null || k.UsnChanged > sinceUsn);

    public AdComputer? ReadComputer(string dn) =>
        Data.Computers.FirstOrDefault(c => string.Equals(c.Dn, dn, StringComparison.OrdinalIgnoreCase));

    public void Dispose() { }
}
