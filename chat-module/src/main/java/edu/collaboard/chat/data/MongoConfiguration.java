package edu.collaboard.chat.data;

import com.mongodb.WriteConcern;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.autoconfigure.mongo.MongoClientSettingsBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class MongoConfiguration {
    @Bean MongoClientSettingsBuilderCustomizer durableWrites() {
        return builder -> builder.writeConcern(WriteConcern.MAJORITY.withJournal(true).withWTimeout(5, TimeUnit.SECONDS))
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(5, TimeUnit.SECONDS))
                .applyToSocketSettings(socket -> socket.connectTimeout(3, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS));
    }
}
