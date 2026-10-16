using System.Text.Json;
using BitlockerSync.Worker.Options;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Sync;

/// <summary>What the worker remembers between runs. No secrets.</summary>
public sealed record SyncState(string? DcName, Guid? InvocationId, DateOnly? LastFullDate);

/// <summary>Reads and writes the small state file (atomic replace, so a crash never leaves half a file).</summary>
public class SyncStateStore(IOptions<ScheduleOptions> options)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    // A relative path is taken from the program's folder, not from the current directory.
    private string Path => System.IO.Path.GetFullPath(options.Value.StateFile, AppContext.BaseDirectory);

    public virtual SyncState Load()
    {
        try
        {
            return File.Exists(Path)
                ? JsonSerializer.Deserialize<SyncState>(File.ReadAllText(Path), Json) ?? Empty
                : Empty;
        }
        catch (JsonException)
        {
            return Empty; // a damaged file only costs one extra full run
        }
    }

    public virtual void Save(SyncState state)
    {
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var tmp = Path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
        File.Move(tmp, Path, overwrite: true);
    }

    private static SyncState Empty => new(null, null, null);
}
