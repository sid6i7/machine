import 'dotenv/config';
import { ActionDispatcher } from './actions/ActionDispatcher.js';
import { InboundMessage } from './services/InboundService.js';

async function bootstrap() {
  const serviceName = process.env.INBOUND_SERVICE || 'WhatsAppService';
  let InboundServiceClass;

  try {
    const module = await import(`./services/${serviceName}.js`);
    InboundServiceClass = module[serviceName];
    if (!InboundServiceClass) {
      throw new Error(`Class ${serviceName} not found in module.`);
    }
  } catch (error: any) {
    console.error(`Failed to load inbound service ${serviceName}:`, error.message);
    process.exit(1);
  }

  const inboundService = new InboundServiceClass();
  const dispatcher = new ActionDispatcher();
  
  await dispatcher.init();

  inboundService.on('message', async (ctx: InboundMessage) => {
    try {
      const response = await dispatcher.dispatch(ctx);
      if (response) {
        await inboundService.sendMessage(ctx.groupID || ctx.sender, response);
      }
    } catch (error: any) {
      console.error(`Error dispatching message: ${error.message}`);
    }
  });

  inboundService.start().catch((err: Error) => {
    console.error(`Failed to start ${serviceName}:`, err);
  });
}

bootstrap();
