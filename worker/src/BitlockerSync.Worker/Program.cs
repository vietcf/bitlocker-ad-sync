using BitlockerSync.Worker.Directory;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Scheduling;
using BitlockerSync.Worker.Security;
using BitlockerSync.Worker.Sync;
using Microsoft.Extensions.Options;

// Usage:
//   BitlockerSync.Worker                      run as a Windows Service (or in a console for testing)
//   BitlockerSync.Worker run-once [full|delta] one sync run now, then exit (exit code 0 = success)
//   BitlockerSync.Worker protect "<secret>"   print a dpapi:... value for appsettings.json
//   BitlockerSync.Worker check                validate the configuration and test the LDAP connection

if (args is ["protect", ..])
{
    if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("protect needs Windows (DPAPI)."); return 1; }
    // Without an argument the secret is typed at a hidden prompt, so it stays out of the shell history.
    var secret = args.Length > 1 ? args[1] : ReadHidden("Secret to protect: ");
    if (string.IsNullOrEmpty(secret)) { Console.Error.WriteLine("Nothing to protect."); return 1; }
    Console.WriteLine(SecretProtector.Protect(secret));
    return 0;
}

static string ReadHidden(string prompt)
{
    Console.Error.Write(prompt);
    var sb = new System.Text.StringBuilder();
    while (true)
    {
        var k = Console.ReadKey(intercept: true);
        if (k.Key == ConsoleKey.Enter) break;
        if (k.Key == ConsoleKey.Backspace) { if (sb.Length > 0) sb.Length--; continue; }
        if (!char.IsControl(k.KeyChar)) sb.Append(k.KeyChar);
    }
    Console.Error.WriteLine();
    return sb.ToString();
}

// appsettings*.json are read from the program's folder, whatever the current directory is
// (a service starts in System32; an admin may run the exe from anywhere).
var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    Args = args.Where(a => a.StartsWith("--", StringComparison.Ordinal)).ToArray(),
    ContentRootPath = AppContext.BaseDirectory,
});
builder.Services.AddWindowsService(o => o.ServiceName = "BitlockerSync");

builder.Services.AddOptions<LdapOptions>().Bind(builder.Configuration.GetSection(LdapOptions.Section)).ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<IngestOptions>().Bind(builder.Configuration.GetSection(IngestOptions.Section)).ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<ScheduleOptions>().Bind(builder.Configuration.GetSection(ScheduleOptions.Section)).ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddSingleton<IValidateOptions<LdapOptions>, LdapOptionsValidator>();
builder.Services.AddSingleton<IValidateOptions<IngestOptions>, IngestOptionsValidator>();

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<SyncStateStore>();
builder.Services.AddSingleton<IDirectoryReaderFactory>(sp =>
    sp.GetRequiredService<IOptions<LdapOptions>>().Value.Source == DirectorySource.JsonFile
        ? ActivatorUtilities.CreateInstance<JsonFileDirectoryReaderFactory>(sp)
        : ActivatorUtilities.CreateInstance<LdapDirectoryReaderFactory>(sp));
builder.Services.AddHttpClient<IIngestApi, IngestApiClient>()
    .ConfigurePrimaryHttpMessageHandler(sp => IngestApiClient.CreateHandler(sp.GetRequiredService<IOptions<IngestOptions>>().Value));
builder.Services.AddSingleton<SyncRunner>();

var command = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal));
if (command is null)
{
    builder.Services.AddHostedService<SyncScheduler>();
    builder.Build().Run();
    return 0;
}

using var host = builder.Build();
await host.StartAsync(); // runs options validation
var services = host.Services;
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

switch (command)
{
    case "run-once":
    {
        var mode = args.Contains("full", StringComparer.OrdinalIgnoreCase) ? SyncMode.Full : SyncMode.Delta;
        var outcome = await services.GetRequiredService<SyncRunner>().RunAsync(mode, cts.Token);
        Console.WriteLine($"Run {outcome.RunId}: {outcome.Mode} -> {outcome.Status}; computers {outcome.ComputersSent}, " +
                          $"keys {outcome.KeysSent}, orphans left {outcome.OrphansLeft}{(outcome.ErrorCode is null ? "" : $", error {outcome.ErrorCode}")}");
        return outcome.Status == "success" ? 0 : 2;
    }
    case "check":
    {
        using var directory = services.GetRequiredService<IDirectoryReaderFactory>().Create();
        try
        {
            var dc = await directory.ConnectAsync(cts.Token);
            Console.WriteLine($"LDAP OK: {dc.DnsHostName}, highestCommittedUSN {dc.HighestCommittedUsn}, invocationId {dc.InvocationId}, " +
                              $"LDAPS certificate expires {dc.CertificateExpiresAt?.ToString("yyyy-MM-dd") ?? "n/a"}");
            if (directory is not LdapDirectoryReader ldap)
            {
                var computers = directory.ReadComputers(null, cts.Token).Take(5).Count();
                Console.WriteLine($"Read access: first {computers} computers");
                return 0;
            }
            // One line per OU of Ldap:SearchBases, so an OU the account cannot read is easy to spot.
            var probes = ldap.ProbeSearchBases(5, cts.Token);
            foreach (var p in probes)
            {
                Console.WriteLine(p.Error is null
                    ? $"  OK    {p.SearchBase}: first {p.Computers} computers, first {p.Keys} keys ({p.KeysWithoutPassword} without a readable password)"
                    : $"  FAIL  {p.SearchBase}: {p.Error}");
            }
            if (probes.Any(p => p.KeysWithoutPassword > 0))
                Console.WriteLine("  WARNING: some keys have no readable password: grant read on msFVE-RecoveryPassword (README 4.1).");
            return probes.Any(p => p.Error is not null) ? 4 : 0;
        }
        catch (DirectoryException ex)
        {
            Console.Error.WriteLine($"LDAP FAILED ({ex.ApiErrorCode}): {ex.Message}");
            return 3;
        }
    }
    default:
        Console.Error.WriteLine($"Unknown command '{command}'. Use: run-once [full|delta] | protect \"<secret>\" | check");
        return 1;
}
