# RabbitMQ de CollaBoard: broker AMQP (conector C07). Solo infraestructura:
# NotificationAPI publica y el MessageWorker consume (módulo de Cristian).
FROM rabbitmq:3.13-management-alpine

COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf
COPY definitions.template.json /etc/rabbitmq/definitions.template.json
COPY render-definitions.sh /usr/local/bin/render-definitions.sh
# Tolera finales de línea CRLF si el repo se clonó en Windows sin .gitattributes.
RUN sed -i 's/\r$//' /usr/local/bin/render-definitions.sh /etc/rabbitmq/rabbitmq.conf /etc/rabbitmq/definitions.template.json \
    && chmod +x /usr/local/bin/render-definitions.sh

ENTRYPOINT ["render-definitions.sh"]
CMD ["rabbitmq-server"]
