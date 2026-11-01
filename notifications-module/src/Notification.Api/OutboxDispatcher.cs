using System.Data;
using System.Text;
using CollaBoard.Notifications;
using Npgsql;

namespace CollaBoard.NotificationApi;

// Outbox transaccional. Si el broker falla, no se confirma published_at.
// Si cae después de la confirmación Rabbit y antes del commit SQL, el evento se
// vuelve a publicar: el consumidor lo deduplica por (event_id, recipient_id).
public sealed class OutboxDispatcher : BackgroundService
{
    private readonly NotificationDatabase _database;
    private readonly ILogger<OutboxDispatcher> _logger;
    public OutboxDispatcher(NotificationDatabase database, ILogger<OutboxDispatcher> logger)
    { _database = database; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await FlushBatchAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                _logger.LogWarning("Outbox: publicación pendiente para reintento ({ErrorType})", error.GetType().Name);
            }
            try { await Task.Delay(TimeSpan.FromMilliseconds(500), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task FlushBatchAsync(CancellationToken ct)
    {
        await using var db = await _database.OpenAsync(ct);
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var pending = new List<(string Id, string Json)>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT o.event_id, e.event_json::text
              FROM notification_outbox o JOIN notification_events e USING(event_id)
             WHERE o.published_at IS NULL
             ORDER BY o.created_at
             FOR UPDATE OF o SKIP LOCKED LIMIT 25
            """, db, tx))
        {
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) pending.Add((reader.GetString(0), reader.GetString(1)));
        }
        if (pending.Count == 0) { await tx.CommitAsync(ct); return; }

        using var connection = Broker.Factory().CreateConnection();
        using var channel = connection.CreateModel();
        Broker.DeclareIfLocal(channel);
        channel.ConfirmSelect();
        foreach (var (id, json) in pending)
        {
            Broker.PublishConfirmed(channel, Encoding.UTF8.GetBytes(json));
            await using var update = new NpgsqlCommand("""
                UPDATE notification_outbox SET published_at=now() WHERE event_id=@id
                """, db, tx);
            update.Parameters.AddWithValue("id", id);
            await update.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
        _logger.LogInformation("Outbox: {Count} eventos publicados y confirmados", pending.Count);
    }
}
