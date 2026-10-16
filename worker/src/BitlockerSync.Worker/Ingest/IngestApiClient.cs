using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using BitlockerSync.Worker.Options;
using BitlockerSync.Worker.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BitlockerSync.Worker.Ingest;

/// <summary>
/// HTTP client for the ingest API. Every call is retried on network errors, timeouts and 5xx with
/// exponential backoff (1s, 2s, 4s ... capped at 5 minutes) until <see cref="IngestOptions.RetryForMinutes"/>;
/// 4xx answers are not retried. Request and response bodies are never logged.
/// </summary>
public sealed class IngestApiClient : IIngestApi
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly IngestOptions _options;
    private readonly ILogger<IngestApiClient> _log;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private int _pendingRetries;

    public IngestApiClient(HttpClient http, IOptions<IngestOptions> options, ILogger<IngestApiClient> log)
        : this(http, options.Value, log, Task.Delay) { }

    /// <summary>Test seam: <paramref name="delay"/> replaces Task.Delay between retries.</summary>
    internal IngestApiClient(HttpClient http, IngestOptions options, ILogger<IngestApiClient> log, Func<TimeSpan, CancellationToken, Task> delay)
    {
        _http = http;
        _options = options;
        _log = log;
        if (options.SkipCertificateValidation)
            log.LogWarning("Ingest:SkipCertificateValidation is on: the server's HTTPS certificate is not checked (encrypted, but a fake server would not be noticed). Lab / self-signed only; prefer Ingest:CaFile.");
        _delay = delay;
        _http.BaseAddress = new Uri(options.BaseUrl.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
        var apiKey = SecretProtector.Reveal(options.ApiKey);
        if (!string.IsNullOrEmpty(apiKey)) _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
    }

    public int PendingRetries => Volatile.Read(ref _pendingRetries);

    /// <summary>
    /// HTTPS handler. The server certificate is checked against the Windows trust store, or, with
    /// Ingest:CaFile, against that CA (an internal or dev CA not installed on the machine).
    /// The worker authenticates with the API key only (Authorization header, set in the constructor).
    /// </summary>
    public static HttpMessageHandler CreateHandler(IngestOptions options, string? baseDirectory = null)
    {
        var handler = new HttpClientHandler();
        if (options.SkipCertificateValidation)
        {
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        else if (!string.IsNullOrWhiteSpace(options.CaFile))
        {
            var path = Path.GetFullPath(options.CaFile, baseDirectory ?? AppContext.BaseDirectory);
            var ca = X509Certificate2.CreateFromPem(File.ReadAllText(path));
            handler.ServerCertificateCustomValidationCallback = (_, cert, _, errors) => TrustedBy(ca, cert, errors);
        }
        return handler;
    }

    /// <summary>Valid for the host name and chained to <paramref name="ca"/> (or already trusted by Windows).</summary>
    internal static bool TrustedBy(X509Certificate2 ca, X509Certificate2? cert, System.Net.Security.SslPolicyErrors errors)
    {
        if (errors == System.Net.Security.SslPolicyErrors.None) return true;
        if (cert is null || errors.HasFlag(System.Net.Security.SslPolicyErrors.RemoteCertificateNameMismatch)) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        return chain.Build(cert);
    }

    public async Task<LastRun?> GetLastRunAsync(CancellationToken ct)
    {
        // The server answers {} when there has never been a successful run.
        var doc = await SendAsync<JsonElement>(() => new HttpRequestMessage(HttpMethod.Get, "sync-runs/last"), "GET sync-runs/last", ct);
        return doc.ValueKind == JsonValueKind.Object && doc.TryGetProperty("runId", out _) ? doc.Deserialize<LastRun>(Json) : null;
    }

    public Task<OpenRunResponse> OpenRunAsync(OpenRunRequest request, CancellationToken ct) =>
        PostAsync<OpenRunResponse>("sync-runs", request, ct);

    public Task<ComputersResult> SendComputersAsync(ComputersBatch batch, CancellationToken ct) =>
        PostAsync<ComputersResult>("computers", batch, ct);

    public Task<KeysResult> SendKeysAsync(KeysBatch batch, CancellationToken ct) =>
        PostAsync<KeysResult>("keys", batch, ct);

    public Task<CompleteResult> CompleteAsync(long runId, CompleteRequest request, CancellationToken ct) =>
        PostAsync<CompleteResult>($"sync-runs/{runId}/complete", request, ct);

    // A heartbeat is tried once: the next one comes in a few minutes anyway, and a long retry
    // would hold up the service loop.
    public Task<HeartbeatResponse> HeartbeatAsync(HeartbeatRequest request, CancellationToken ct) =>
        PostAsync<HeartbeatResponse>("heartbeat", request, ct, retry: false);

    private Task<T> PostAsync<T>(string path, object body, CancellationToken ct, bool retry = true) =>
        SendAsync<T>(() => new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body, body.GetType(), options: Json) }, $"POST {path}", ct, retry);

    private async Task<T> SendAsync<T>(Func<HttpRequestMessage> build, string what, CancellationToken ct, bool retry = true)
    {
        var deadline = retry ? DateTimeOffset.UtcNow.AddMinutes(_options.RetryForMinutes) : DateTimeOffset.UtcNow;
        var attempt = 0;
        while (true)
        {
            try
            {
                using var request = build();
                using var response = await _http.SendAsync(request, ct);
                if (response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<T>(Json, ct)
                           ?? throw new IngestException($"{what}: empty response", (int)response.StatusCode);
                }
                throw await ToExceptionAsync(response, what, ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                await WaitOrGiveUpAsync(new IngestException($"{what}: {ex.Message}", inner: ex), ++attempt, deadline, ct);
            }
            catch (IngestException ex) when (ex.IsTransient)
            {
                await WaitOrGiveUpAsync(ex, ++attempt, deadline, ct);
            }
        }
    }

    private async Task WaitOrGiveUpAsync(IngestException error, int attempt, DateTimeOffset deadline, CancellationToken ct)
    {
        var wait = TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, attempt - 1)));
        if (DateTimeOffset.UtcNow + wait > deadline) throw error;
        _log.LogWarning("Ingest API call failed ({Reason}); retry {Attempt} in {Wait}s", error.Message, attempt, (int)wait.TotalSeconds);
        Interlocked.Increment(ref _pendingRetries);
        try { await _delay(wait, ct); }
        finally { Interlocked.Decrement(ref _pendingRetries); }
    }

    private static async Task<IngestException> ToExceptionAsync(HttpResponseMessage response, string what, CancellationToken ct)
    {
        string? code = null;
        string? message = null;
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            if (body.ValueKind == JsonValueKind.Object)
            {
                if (body.TryGetProperty("error", out var e)) code = e.GetString();
                if (body.TryGetProperty("message", out var m)) message = m.GetString();
            }
        }
        catch (JsonException) { /* not JSON (e.g. a proxy error page) */ }
        return new IngestException($"{what}: HTTP {(int)response.StatusCode} {code} {message}".TrimEnd(), (int)response.StatusCode, code);
    }
}
