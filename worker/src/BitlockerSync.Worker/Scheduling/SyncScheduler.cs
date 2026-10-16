using System.Globalization;
using System.Reflection;
using BitlockerSync.Worker.Ingest;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Sync;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Scheduling;

/// <summary>
/// The service loop. One loop, so two runs never overlap:
///  - heartbeat every HeartbeatEveryMinutes; a manual request from Admin HQ starts that run now;
///  - a full run once a day at FullAt (and at first start, when none was ever done);
///  - otherwise a delta every DeltaEveryMinutes.
/// Any failure is logged and the loop goes on.
/// </summary>
public sealed class SyncScheduler(
    SyncRunner runner,
    IIngestApi api,
    SyncStateStore state,
    IOptions<ScheduleOptions> options,
    TimeProvider time,
    ILogger<SyncScheduler> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(30);
    private static readonly string Version =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    private SyncOutcome? _last;
    private DateTimeOffset _nextHeartbeat = DateTimeOffset.MinValue;
    private DateTimeOffset _nextDelta = DateTimeOffset.MinValue;

    private ScheduleOptions O => options.Value;
    private string WorkerId => string.IsNullOrWhiteSpace(O.WorkerId) ? Environment.MachineName : O.WorkerId!;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("BitlockerSync worker {Version} started as {WorkerId}", Version, WorkerId);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await StepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Scheduler step failed");
            }
            await Task.Delay(Tick, time, stoppingToken).ContinueWith(_ => { }, TaskScheduler.Default);
        }
    }

    /// <summary>One pass of the loop (internal for tests).</summary>
    internal async Task StepAsync(CancellationToken ct)
    {
        var now = time.GetLocalNow();
        SyncMode? requested = null;

        if (now >= _nextHeartbeat)
        {
            _nextHeartbeat = now.AddMinutes(O.HeartbeatEveryMinutes);
            requested = await HeartbeatAsync(ct);
        }

        var mode = requested ?? (IsFullDue(now) ? SyncMode.Full : now >= _nextDelta ? SyncMode.Delta : null);
        if (mode is null) return;

        if (requested is not null) log.LogInformation("Admin HQ requested a {Mode} sync", requested);
        _last = await runner.RunAsync(mode.Value, ct);
        _nextDelta = time.GetLocalNow().AddMinutes(O.DeltaEveryMinutes);
    }

    private bool IsFullDue(DateTimeOffset now)
    {
        var lastFull = state.Load().LastFullDate;
        if (lastFull is null) return true; // first start: load everything
        var at = TimeOnly.ParseExact(O.FullAt, "HH:mm", CultureInfo.InvariantCulture);
        var today = DateOnly.FromDateTime(now.DateTime);
        return lastFull < today && TimeOnly.FromDateTime(now.DateTime) >= at;
    }

    private async Task<SyncMode?> HeartbeatAsync(CancellationToken ct)
    {
        try
        {
            var response = await api.HeartbeatAsync(new HeartbeatRequest(
                WorkerId,
                Version,
                _last?.Dc?.DnsHostName,
                _last?.LdapOk,
                _last?.ErrorCode,
                api.PendingRetries,
                _last?.Dc?.CertificateExpiresAt,
                null), ct);
            return response.SyncRequested switch
            {
                "full" => SyncMode.Full,
                "delta" => SyncMode.Delta,
                _ => null,
            };
        }
        catch (IngestException ex)
        {
            log.LogWarning("Heartbeat failed: {Reason}", ex.Message);
            return null;
        }
    }
}
