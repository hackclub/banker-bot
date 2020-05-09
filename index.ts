// import { createEventAdapter } from "@slack/events-api";
import { environment } from './environment';
import { App } from '@slack/bolt';

const app = new App({
    signingSecret: environment["sign-secret"],
    token: environment["bot-token"],
    endpoints: {
        events: '/slack/events',
        commands: '/slack/commands'
    }
});

(async () => {
    // Start your app
    await app.start(environment["port"]);

    app.command("/give-test", async ({ command, ack, context, respond }) => {
        // await giveCommand(command, say)
        console.log(JSON.stringify(command, null, 2))
        await ack()
        await app.client.chat.postMessage({
            text: command.text,
            channel: command.channel_id,
            as_user: true,
            token: context.token
        })
    })

    app.command("/balance-test", async ({ command, ack, say }) => {

    })

    app.command("/invoice-test", async ({ command, ack, say }) => {

    })

    app.command("/slip", async ({ command, ack, say }) => {

    })

    app.command("/invoices-test", async ({ command, ack, say }) => {

    })

    console.log('⚡️ Bolt app is running!');
})();