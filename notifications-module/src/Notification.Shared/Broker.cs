using RabbitMQ.Client;

namespace CollaBoard.Notifications;

// Compatible con el broker de Sebastian: cola QUORUM, DLX y privilegios mínimos.
// En el despliegue final la topología se declara desde rabbitmq/definitions.template.json;
// API solo tiene permiso WRITE en el exchange y Worker solo READ en la cola.
public static class Broker
{
    public static string Exchange => Environment.GetEnvironmentVariable("RABBITMQ_EVENTS_EXCHANGE") ?? "notifications.events";
    public static string Queue => Environment.GetEnvironmentVariable("RABBITMQ_TASKS_QUEUE") ?? "notifications.tasks";
    public static string Key => Environment.GetEnvironmentVariable("RABBITMQ_TASKS_ROUTING_KEY") ?? "notification.task";
    public static string DeadExchange => Environment.GetEnvironmentVariable("RABBITMQ_DLX") ?? "notifications.dlx";
    public static string DeadQueue => Environment.GetEnvironmentVariable("RABBITMQ_DLQ") ?? "notifications.tasks.dlq";
    public static string DeadKey => Environment.GetEnvironmentVariable("RABBITMQ_DLQ_ROUTING_KEY") ?? "notifications.failed";
    public static bool Managed => bool.TryParse(Environment.GetEnvironmentVariable("RABBITMQ_MANAGED_TOPOLOGY"), out var enabled) && enabled;

    public static ConnectionFactory Factory() => new()
    {
        HostName = Environment.GetEnvironmentVariable("RABBITMQ_HOST") ?? "rabbitmq",
        Port = int.TryParse(Environment.GetEnvironmentVariable("RABBITMQ_PORT"), out var p) ? p : 5672,
        VirtualHost = Environment.GetEnvironmentVariable("RABBITMQ_VHOST") ?? "/",
        UserName = Environment.GetEnvironmentVariable("RABBITMQ_USER") ?? "collaboard",
        Password = Environment.GetEnvironmentVariable("RABBITMQ_PASSWORD") ?? throw new InvalidOperationException("RABBITMQ_PASSWORD requerida"),
        AutomaticRecoveryEnabled = false,
        RequestedConnectionTimeout = TimeSpan.FromSeconds(5)
    };

    // SOLO entorno local sin infraestructura preconfigurada; el broker de Sebastian
    // ya trae esta definición y deniega configure a los procesos de negocio.
    public static void DeclareIfLocal(IModel channel)
    {
        if (Managed) return;
        channel.ExchangeDeclare(Exchange, ExchangeType.Direct, durable: true, autoDelete: false);
        channel.ExchangeDeclare(DeadExchange, ExchangeType.Direct, durable: true, autoDelete: false);
        channel.QueueDeclare(Queue, durable: true, exclusive: false, autoDelete: false,
            arguments: new Dictionary<string, object>
            {
                ["x-queue-type"] = "quorum",
                ["x-dead-letter-exchange"] = DeadExchange,
                ["x-dead-letter-routing-key"] = DeadKey,
                ["x-delivery-limit"] = 2  // 3 entregas totales, igual que la topología de Sebastian
            });
        channel.QueueBind(Queue, Exchange, Key);
        channel.QueueDeclare(DeadQueue, durable: true, exclusive: false, autoDelete: false,
            arguments: new Dictionary<string, object> { ["x-queue-type"] = "quorum" });
        channel.QueueBind(DeadQueue, DeadExchange, DeadKey);
    }

    public static void PublishConfirmed(IModel channel, byte[] body)
    {
        var properties = channel.CreateBasicProperties();
        properties.Persistent = true;
        properties.ContentType = "application/json";
        channel.BasicPublish(Exchange, Key, mandatory: true, basicProperties: properties, body: body);
        channel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(8));
    }
}
