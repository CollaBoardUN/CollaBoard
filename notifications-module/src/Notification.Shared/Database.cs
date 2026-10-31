using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

namespace CollaBoard.Notifications;

public sealed class NotificationDatabase
{
    private readonly string _connectionString;
    public NotificationDatabase(string connectionString) => _connectionString = connectionString;

    public async Task<NpgsqlConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    public async Task MigrateAsync(CancellationToken ct)
    {
        await using var connection = await OpenAsync(ct);
        await using var command = new NpgsqlCommand(Schema, connection);
        await command.ExecuteNonQueryAsync(ct);
    }

    // Simple migración inicial idempotente. No elimina tablas ni datos existentes.
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS notification_events (
            event_id TEXT PRIMARY KEY,
            event_hash TEXT NOT NULL,
            event_json JSONB NOT NULL,
            received_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS notification_outbox (
            event_id TEXT PRIMARY KEY REFERENCES notification_events(event_id),
            published_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
            ON notification_outbox(created_at) WHERE published_at IS NULL;
        CREATE TABLE IF NOT EXISTS notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            type TEXT NOT NULL,
            board_id TEXT,
            actor_id TEXT,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            read_at TIMESTAMPTZ,
            CONSTRAINT uq_notification_event_recipient UNIQUE (event_id, recipient_id)
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_inbox
            ON notifications(recipient_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_unread
            ON notifications(recipient_id) WHERE read_at IS NULL;
        """;

    public async Task<string> AcceptEventAsync(NotificationEvent item, CancellationToken ct)
    {
        var canonical = JsonSerializer.Serialize(item);
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
        await using var db = await OpenAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        await using (var insert = new NpgsqlCommand("""
            INSERT INTO notification_events(event_id, event_hash, event_json)
            VALUES (@id, @hash, @json::jsonb)
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id
            """, db, tx))
        {
            insert.Parameters.AddWithValue("id", item.EventId);
            insert.Parameters.AddWithValue("hash", fingerprint);
            insert.Parameters.AddWithValue("json", canonical);
            var result = await insert.ExecuteScalarAsync(ct);
            if (result != null)
            {
                await using var outbox = new NpgsqlCommand("INSERT INTO notification_outbox(event_id) VALUES (@id)", db, tx);
                outbox.Parameters.AddWithValue("id", item.EventId);
                await outbox.ExecuteNonQueryAsync(ct);
                await tx.CommitAsync(ct);
                return "accepted";
            }
        }
        await using (var existing = new NpgsqlCommand("SELECT event_hash FROM notification_events WHERE event_id=@id", db, tx))
        {
            existing.Parameters.AddWithValue("id", item.EventId);
            var hash = (string?)await existing.ExecuteScalarAsync(ct);
            if (hash != fingerprint) return "conflict";
        }
        await tx.CommitAsync(ct);
        return "duplicate";
    }

    public async Task<InboxResponse> GetInboxAsync(string userId, int limit, CancellationToken ct)
    {
        await using var db = await OpenAsync(ct);
        var items = new List<NotificationItem>();
        await using (var cmd = new NpgsqlCommand("""
            SELECT id::text, type, board_id, actor_id, payload::text, created_at, read_at
              FROM notifications
             WHERE recipient_id = @user
             ORDER BY created_at DESC, id DESC LIMIT @limit
            """, db))
        {
            cmd.Parameters.AddWithValue("user", userId);
            cmd.Parameters.AddWithValue("limit", limit);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) items.Add(ReadNotification(reader));
        }
        await using var count = new NpgsqlCommand(
            "SELECT count(*)::int FROM notifications WHERE recipient_id=@user AND read_at IS NULL", db);
        count.Parameters.AddWithValue("user", userId);
        return new InboxResponse(items, (int)(await count.ExecuteScalarAsync(ct) ?? 0));
    }

    public async Task<NotificationItem?> MarkReadAsync(string userId, Guid id, CancellationToken ct)
    {
        await using var db = await OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            UPDATE notifications SET read_at=COALESCE(read_at,now())
             WHERE recipient_id=@user AND id=@id
            RETURNING id::text, type, board_id, actor_id, payload::text, created_at, read_at
            """, db);
        cmd.Parameters.AddWithValue("user", userId);
        cmd.Parameters.AddWithValue("id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadNotification(reader) : null;
    }

    private static NotificationItem ReadNotification(NpgsqlDataReader r)
    {
        using var parsed = JsonDocument.Parse(r.GetString(4));
        return new NotificationItem(r.GetString(0), r.GetString(1),
            r.IsDBNull(2) ? null : r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3),
            parsed.RootElement.Clone(), new DateTimeOffset(r.GetDateTime(5), TimeSpan.Zero),
            r.IsDBNull(6) ? null : new DateTimeOffset(r.GetDateTime(6), TimeSpan.Zero));
    }

    // Transacción única: evento/destinatario es único; se confirma antes del ack RabbitMQ.
    public async Task DeliverAsync(NotificationEvent item, CancellationToken ct)
    {
        await using var db = await OpenAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        foreach (var userId in item.RecipientIds.Distinct(StringComparer.Ordinal))
        {
            if (userId == item.ActorId) continue;
            await using var cmd = new NpgsqlCommand("""
                INSERT INTO notifications(event_id,recipient_id,type,board_id,actor_id,payload)
                VALUES (@event,@recipient,@type,@board,@actor,@payload::jsonb)
                ON CONFLICT (event_id,recipient_id) DO NOTHING
                """, db, tx);
            cmd.Parameters.AddWithValue("event", item.EventId);
            cmd.Parameters.AddWithValue("recipient", userId);
            cmd.Parameters.AddWithValue("type", item.Type);
            cmd.Parameters.AddWithValue("board", item.BoardId);
            cmd.Parameters.AddWithValue("actor", item.ActorId);
            cmd.Parameters.AddWithValue("payload", item.Payload.GetRawText());
            await cmd.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }
}
