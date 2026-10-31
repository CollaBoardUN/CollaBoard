using System.Text;
using System.Text.Json;
using CollaBoard.Notifications;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

var builder = Host.CreateApplicationBuilder(args);
var cs = Environment.GetEnvironmentVariable("NOTIFICATION_DATABASE_URL")
    ?? throw new InvalidOperationException("NOTIFICATION_DATABASE_URL requerida");
builder.Services.AddSingleton(new NotificationDatabase(cs));
builder.Services.AddHostedService<NotificationConsumer>();
await builder.Build().RunAsync();

internal sealed class NotificationConsumer : BackgroundService
{
    private readonly NotificationDatabase _db;
    private readonly ILogger<NotificationConsumer> _logger;
    public NotificationConsumer(NotificationDatabase db, ILogger<NotificationConsumer> logger)
    { _db = db; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var connection = Broker.Factory().CreateConnection();
                using var channel = connection.CreateModel();
                Broker.DeclareIfLocal(channel);
                channel.ConfirmSelect();
                channel.BasicQos(0, 1, false);
                using var done = new ManualResetEventSlim(false);
                connection.ConnectionShutdown += (_, _) => done.Set();
                var consumer = new EventingBasicConsumer(channel);
                consumer.Received += (_, delivery) => Process(channel, delivery);
                channel.BasicConsume(Broker.Queue, autoAck: false, consumer: consumer);
                _logger.LogInformation("MessageWorker C#: escuchando {Queue}", Broker.Queue);
                while (!stop.IsCancellationRequested && connection.IsOpen && channel.IsOpen && !done.IsSet)
                    await Task.Delay(500, stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                _logger.LogWarning("Worker desconectado; se reconectará ({ErrorType})", error.GetType().Name);
            }
            try { await Task.Delay(2000, stop); } catch (OperationCanceledException) { break; }
        }
    }

    private void Process(IModel channel, BasicDeliverEventArgs delivery)
    {
        try
        {
            var item = JsonSerializer.Deserialize<NotificationEvent>(delivery.Body.Span);
            var validation = EventValidation.Error(item);
            if (validation != null) throw new InvalidDataException(validation);
            _db.DeliverAsync(item!, CancellationToken.None).GetAwaiter().GetResult();
            // ACK solo después del COMMIT. Si el ACK se pierde, la reentrega es inocua.
            channel.BasicAck(delivery.DeliveryTag, multiple: false);
        }
        catch (Exception error)
        {
            _logger.LogWarning("Worker: entrega fallida ({ErrorType}); broker reintenta hasta DLQ",
                error.GetType().Name);
            try
            {
                // RabbitMQ QUORUM gestiona x-delivery-count y x-delivery-limit=2.
                // Tras tres entregas sin ACK envía a DLQ. No republicamos con
                // credenciales del worker (que solo tiene permisos READ).
                channel.BasicNack(delivery.DeliveryTag, multiple: false, requeue: true);
            }
            catch { /* Al cerrar canal RabbitMQ reentrega mensajes sin ACK. */ }
        }
    }
}
