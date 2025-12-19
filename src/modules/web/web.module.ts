import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { WebController } from './web.controller';
import { CurrentUserMiddleware } from './current-user.middleware';
import { RequireAuthMiddleware } from './require-auth.middleware';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';

@Module({
  imports: [HubspotModule],
  controllers: [WebController],
  providers: [CurrentUserMiddleware, RequireAuthMiddleware],
})
export class WebModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Always attach res.locals.currentUser (for templates)
    consumer.apply(CurrentUserMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });

    // Protect app pages
    consumer
      .apply(RequireAuthMiddleware)
      .forRoutes(
        { path: 'chat', method: RequestMethod.ALL },
        { path: 'threads', method: RequestMethod.ALL },
        { path: 'settings', method: RequestMethod.ALL },
      );
  }
}
