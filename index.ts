import { App } from "@slack/bolt";
import { environment } from './environment';

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

    app.command("/give-test", async ({ command, ack, say }) => {
        await ack();

        await say(`${command.text}`).catch(e => console.log(e));

        console.log(command.text.split(" "))
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