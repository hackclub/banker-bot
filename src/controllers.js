const Botkit = require('botkit');
const redisStorage = require('botkit-storage-redis')(redisConfig);

const controller = Botkit.slackbot({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  clientSigningSecret: process.env.SLACK_CLIENT_SIGNING_SECRET,
  scopes: ['bot', 'chat:write:bot'],
  storage: redisStorage,
});

const redisConfig = {
  url: process.env.REDISCLOUD_URL
};

controller.setupWebserver(process.env.PORT, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);
  controller.createOauthEndpoints(controller.webserver);
});

// @bot balance --> Returns my balance
// @bot balance @zrl --> Returns zrl's balance
const balancePattern = /^balance(?:\s+<@([A-z|0-9]+)>)?/i;
controller.hears(
  balancePattern.source,
  'direct_mention,direct_message,bot_message',
  (bot, message) => {
    const { text, user } = message;
    const captures = balancePattern.exec(text);
    const target = captures[1] || user;

    console.log(
      `Received balance request from User ${user} for User ${target}`
    );
    console.log(message);

    getBalance(target, (balance) => {
      const reply =
        user == target
          ? `You have ${balance}gp in your account, sirrah.`
          : `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`;
      bot.replyInThread(message, reply);
    });
  }
);

// @bot give @zrl 100 --> Gives 100gp from my account to zrl's
const givePattern = /give\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i;
controller.hears(
  givePattern.source,
  'direct_mention,direct_message,bot_message',
  (bot, message) => {
    // console.log(message)
    var { text, user, event, ts, channel } = message;
    if (message.thread_ts) {
      ts = message.thread_ts;
    }
    if (message.type == 'bot_message' && !data.bots.includes(user)) return;

    console.log(`Processing give request from ${user}`);
    console.log(message);

    var target = message.match[1];
    var amount = message.match[2];
    var note = message.match[3] || '';

    var replyCallback = (text) => bot.replyInThread(message, text);

    transfer(
      bot,
      event['channel_type'],
      user,
      target,
      amount,
      note,
      replyCallback,
      ts,
      channel
    );
  }
);

// @bot invoice @zrl 100 for stickers --> Creates invoice for 100gp & notifies @zrl
const invoicePattern = /invoice\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i;
controller.hears(
  invoicePattern.source,
  'direct_mention,direct_message,bot_message',
  (bot, message) => {
    var { text, user, event, ts, channel } = message;
    if (message.thread_ts) {
      ts = message.thread_ts;
    }
    if (message.type == 'bot_message' && !data.bots.includes(user)) return;

    console.log(`Processing invoice request from ${user}`);

    var target = message.match[1];
    var amount = message.match[2];
    var note = message.match[3] || '';

    var replyCallback = (text) => bot.replyInThread(message, text);
    invoice(
      bot,
      event['channel_type'],
      user,
      target,
      amount,
      note,
      replyCallback,
      ts,
      channel
    );
  }
);

// @bot pay rec182yhe902 --> pays an invoice
const payPattern = /pay\s+([A-z|0-9]+)/i;
controller.hears(
  payPattern.source,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    var { text, user, event, ts, channel } = message;
    if (message.thread_ts) {
      ts = message.thread_ts;
    }
    if (message.type == 'bot_message' && !data.bots.includes(user)) return;

    console.log(`Processing invoice payment from ${user}`);

    var id = message.match[1];
    var invRecord = await getInvoice(id);

    if (invRecord.fields['Paid']) {
      bot.replyInThread(message, "You've already paid this invoice!");
    }

    var replyCallback = (text, wentThrough) => {
      bot.replyInThread(message, text);
      if (typeof invoiceReplies[id] == 'function' && wentThrough) {
        invoiceReplies[id](
          `<@${user}> paid their invoice of ${amount} gp from <@${target}>${invRecord.fields['Reason']}`
        );
      }
    };
    var amount = invRecord.fields['Amount'];
    var target = invRecord.fields['From'];
    var note = `for invoice ${invRecord.id}`;
    var replyCallback = (text) => {
      bot.replyInThread(message, text);
      if (typeof invoiceReplies[id] == 'function') {
        invoiceReplies[id](
          `<@${user}> paid their invoice of ${amount} gp from <@${target}>${invRecord.fields['Reason']}`
        );
      }
    };

    transfer(
      bot,
      channel.type,
      user,
      target,
      amount,
      note,
      replyCallback,
      ts,
      channel
    );
  }
);

controller.on('slash_command', (bot, message) => {
  var { command, text, user_id, ts, channel } = message;
  var user = user_id;
  console.log(`Slash command received from ${user_id}: ${text}`);
  console.log(message);

  bot.replyAcknowledge();

  if (message.channel_id == process.env.SLACK_SELF_ID) {
    bot.replyPublicDelayed(
      message,
      "Just fyi... You're talking to me already... no need for slash commands to summon me!"
    );
  } else {
    if (command == '/give') {
      var pattern = /<@([A-z|0-9]+)\|.+>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/;
      var match = pattern.exec(text);
      if (match) {
        var target = match[1];
        var amount = match[2];
        var note = match[3] || '';

        var replyCallback = (text) =>
          bot.replyPublicDelayed(message, {
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: text,
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Transferred by <@${user_id}>`,
                  },
                ],
              },
            ],
          });

        transfer(
          bot,
          'public',
          user_id,
          target,
          amount,
          note,
          replyCallback,
          ts,
          channel
        );
      } else {
        bot.replyPrivateDelayed(
          message,
          'I do not understand! Please type your message as `/give @user [positive-amount]gp for [reason]`'
        );
      }
    }

    if (command == '/balance') {
      var pattern = /(?:<@([A-z|0-9]+)\|.+>)?/i;
      var match = pattern.exec(text);
      if (match) {
        var target = match[1] || user;
        console.log(
          `Received balance request from User ${user} for User ${target}`
        );
        getBalance(target, (balance) => {
          var reply =
            user == target
              ? `Ah yes, <@${target}> (${target}). You have ${balance}gp in your account, sirrah.`
              : `Ah yes, <@${target}> (${target})—they have ${balance}gp.`;
          bot.replyPublicDelayed(message, {
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: reply,
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Requested by <@${user}>`,
                  },
                ],
              },
            ],
          });
        });
      }
    }
  }
});

controller.hears('.*', 'direct_mention,direct_message', (bot, message) => {
  var { text, user } = message;
  console.log(`Received unhandled message from User ${user}:\n${text}`);

  // Ignore if reply is in a thread. Hack to work around infinite bot loops.
  if (_.has(message.event, 'parent_user_id')) return;

  bot.replyInThread(message, 'Pardon me, but I do not understand.');
});
