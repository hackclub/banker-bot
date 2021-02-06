var Botkit = require('botkit');
var Airtable = require('airtable');
var Bottleneck = require('bottleneck');
var _ = require('lodash');
var fs = require('fs');
var fetch = require('node-fetch');

var base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY,
}).base(process.env.AIRTABLE_BASE);

var data = {};

base("api").select().all().then(records => {
  records.forEach(record => {
    data[record.fields.ID] = {
      secret: record.fields.Token,
      hook: record.fields.Webhook
    }
  })
})

var redisConfig = {
  url: process.env.REDISCLOUD_URL,
};
var redisStorage = require('botkit-storage-redis')(redisConfig);

var startBalance = 0;

var invoiceReplies = {};

console.log('Booting bank bot');

function createBalance(user, cb = () => { }) {
  console.log(`Creating balance for User ${user}`);

  base('bank').create(
    {
      User: user,
      Balance: startBalance,
    },
    function (err, record) {
      if (err) {
        console.error(err);
        return;
      }
      console.log(`New balance created for User ${user}`);
      // console.log(record)
      cb(startBalance, record);
    }
  );
}

function setBalance(id, amount, user, cb = () => { }) {
  console.log(`Changing balance for Record ${id} by ${amount}`);
  getBalance(user, (bal) => {
    base('bank').update(
      id,
      {
        Balance: bal + amount,
      },
      (err, record) => {
        if (err) {
          console.error(err);
          return;
        }
        console.log(`Balance for Record ${id} set to ${bal + amount}`);
        cb(bal + amount, record);
      }
    );
  });
}

function getBalance(user, cb = () => { }) {
  console.log(`Retrieving balance for User ${user}`);

  base('bank')
    .select({
      filterByFormula: `User = "${user}"`,
    })
    .firstPage(function page(err, records) {
      if (err) {
        console.error(err);
        return;
      }

      if (records.length == 0) {
        console.log(`No balance found for User ${user}.`);
        createBalance(user, cb);
      } else {
        var record = records[0];
        var fields = record.fields;
        var balance = fields['Balance'];
        console.log(`Balance for User ${user} is ${balance}`);
        console.log(fields);
        cb(balance, record);
      }
    });
}

function getInvoice(id) {
  return new Promise((resolve, reject) => {
    base('invoices').find(id, (err, record) => {
      if (err) {
        console.error(err);
        reject(err);
      }
      resolve(record);
    });
  });
}

console.log('Booting banker bot');

var controller = Botkit.slackbot({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  clientSigningSecret: process.env.SLACK_CLIENT_SIGNING_SECRET,
  scopes: ['bot', 'chat:write:bot'],
  storage: redisStorage,
});

controller.setupWebserver(process.env.PORT, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);
  controller.createOauthEndpoints(controller.webserver);
});

function matchData(str, pattern, keys, obj = {}) {
  var match = pattern.exec(str);

  if (match) {
    var text = _.head(match);
    var vals = _.tail(match);
    var zip = _.zipObject(keys, vals);
    _.defaults(obj, zip);
    return obj;
  }

  return null;
}

// @bot balance --> Returns my balance
// @bot balance @zrl --> Returns zrl's balance
var balancePattern = /^balance(?:\s+<@([A-z|0-9]+)>)?/i;
controller.hears(
  balancePattern.source,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    var { text, user } = message;
    var captures = balancePattern.exec(text);
    var target = captures[1] || user;

    const verifyResult = await verifyPayload(text);

    if (verifyResult[0] != 204) {
      bot.replyInThread(message, JSON.parse(verifyResult[1])['text']);
    } else {
      console.log(
        `Received balance request from User ${user} for User ${target}`
      );
      console.log(message);

      getBalance(target, (balance) => {
        var reply =
          user == target
            ? `You have ${balance}gp in your account, hackalacker.`
            : `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`;
        bot.replyInThread(message, reply);
      });
    }
  }
);

var invoice = async (
  bot,
  channelType,
  sender,
  recipient,
  amount,
  note,
  replyCallback,
  ts,
  channelid
) => {
  if (sender == recipient) {
    console.log(`${sender} attempting to invoice theirself`);
    replyCallback(`What are you trying to pull here, <@${sender}>?`);

    return;
  }

  if (amount === 0) {
    console.log(`${sender} attempting to send 0gp`);
    replyCallback(`no`);

    return;
  }

  var replyNote = note ? ` for "${note}".` : '.';

  replyCallback(`I shall invoice <@${recipient}> ${amount}gp` + replyNote);

  var invRecord = await createInvoice(sender, recipient, amount, replyNote);

  var isPrivate = false;

  invoiceReplies[invRecord.id] = replyCallback;

  bot.say({
    user: '@' + recipient,
    channel: '@' + recipient,
    text: `Good morrow hackalacker. <@${sender}> has just sent you an invoice of ${amount}gp${replyNote}
       Reply with "@banker pay ${invRecord.id}".`,
  });
};

var txLimiter = new Bottleneck({
  maxConcurrent: 1,
});

var transfer = (args, cb) => txLimiter.submit(transferJob, args, cb);

var transferJob = (
  { bot, channelType, user, target, amount, note, ts, channelid },
  replyCallback
) => {
  if (user == target) {
    console.log(`${user} attempting to transfer to theirself`);
    replyCallback(`What are you trying to pull here, <@${user}>?`);

    logTransaction(user, target, amount, note, false, 'Self transfer');
    return;
  }

  getBalance(user, (userBalance, userRecord) => {
    if (userBalance < amount) {
      console.log(`User has insufficient funds`);
      replyCallback(
        `Regrettably, you only have ${userBalance}gp in your account.`,
        false
      );

      logTransaction(user, target, amount, note, false, 'Insufficient funds');
    } else {
      getBalance(target, (targetBalance, targetRecord) => {
        setBalance(userRecord.id, -amount, user);
        // Treats targetBalance+amount as a string concatenation. WHY???
        setBalance(targetRecord.id, -(-amount), target);

        var replyNote = note ? ` for "${note}".` : '.';

        replyCallback(
          `I shall transfer ${amount}gp to <@${target}> immediately` +
          replyNote,
          true
        );

        var isPrivate = false;

        if (data.bots.includes(target)) {
          // send clean, splittable data string
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `$$$ | <@${user}> | ${amount} | ${replyNote} | ${channelid} | ${ts}`,
          });
          
           //webhook
          if (data[target].hook != undefined) {
            fetch(data[target].hook, {
              method: 'post',
              body: JSON.stringify({
                user,
                amount,
                replyNote,
                channelid,
                ts,
                secret: data[target].secret
              })
            });
          }
        }
        } else if (channelType == 'im') {
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `Good morrow hackalacker. <@${user}> has just transferred ${amount}gp to your account${replyNote}`,
          });

          isPrivate = true;
        } 

        logTransaction(user, target, amount, note, true, '', isPrivate);
      });
    }
  });
};

// log transactions in ledger
// parameters: user, target, amount, note, success, log message, private
function logTransaction(u, t, a, n, s, m, p) {
  if (p === undefined) p = false;

  console.log(parseInt(a));

  base('ledger').create(
    {
      From: u,
      To: t,
      Amount: parseInt(a),
      Note: n,
      Success: s,
      'Admin Note': m,
      Timestamp: Date.now(),
      Private: p,
    },
    function (err, record) {
      if (err) {
        console.error(err);
        return;
      }
      console.log('New ledger transaction logged: ' + record.getId());
    }
  );
}

// log invoice on airtable
function createInvoice(sender, recipient, amount, note) {
  return new Promise((resolve, reject) => {
    base('invoices').create(
      {
        From: sender,
        To: recipient,
        Amount: parseInt(amount),
        Reason: note,
      },
      function (err, record) {
        if (err) {
          console.error(err);
          reject(err);
        }
        console.log('New invoice created:', record.getId());
        resolve(record);
      }
    );
  });
}

// @bot give @zrl 100 --> Gives 100gp from my account to zrl's
controller.hears(
  /give\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    // console.log(message)
    var { text, user, event, ts, channel } = message;

    const verifyResult = await verifyPayload(text);

    if (verifyResult[0] != 204) {
      bot.replyInThread(message, JSON.parse(verifyResult[1])['text']);
    } else {
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
        {
          bot,
          channelType: event['channel_type'],
          user,
          target,
          amount,
          note,
          ts,
          channelid: channel,
        },
        replyCallback
      );
    }
  }
);

// @bot invoice @zrl 100 for stickers --> Creates invoice for 100gp & notifies @zrl

controller.hears(
  /invoice\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    var { text, user, event, ts, channel } = message;

    const verifyResult = await verifyPayload(text);

    if (verifyResult[0] != 204) {
      bot.replyInThread(message, JSON.parse(verifyResult[1])['text']);
    } else {
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
  }
);

// @bot pay rec182yhe902 --> pays an invoice

controller.hears(
  /pay\s+([A-z|0-9]+)/i,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    var { text, user, event, ts, channel } = message;

    const verifyResult = await verifyPayload(text);

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
    var amount = invRecord.fields['Amount'];
    var target = invRecord.fields['From'];
    var note = `for invoice ${invRecord.id}`;
    var replyCallback = (text, wentThrough) => {
      bot.replyInThread(message, text);
      if (typeof invoiceReplies[id] == 'function' && wentThrough) {
        invoiceReplies[id](
          `<@${user}> paid their invoice of ${amount} gp from <@${target}>${invRecord.fields['Reason']}`
        );
      }
    };

    transfer(
      {
        bot,
        channelType: channel.type,
        user,
        target,
        amount,
        note,
        ts,
        channelid: channel,
      },
      replyCallback
    );
  }
);

controller.on('slash_command', async (bot, message) => {
  var { command, text, user_id, ts, channel } = message;
  var user = user_id;
  console.log(`Slash command received from ${user_id}: ${text}`);
  console.log(message);

  bot.replyAcknowledge();

  const verifyResult = await verifyPayload(text);

  if (verifyResult[0] != 204) {
    bot.replyPrivateDelayed(message, JSON.parse(verifyResult[1])['text']);
  } else {
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
            {
              bot,
              channelType: 'public',
              user: user_id,
              target,
              amount,
              note,
              ts,
              channel,
            },
            replyCallback
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
                ? `Ah yes, <@${target}> (${target}). You have ${balance}gp in your account, hackalacker.`
                : `Ah yes, <@${target}> (${target})—they have ${balance}gp.`;
            bot.replyPrivateDelayed(message, {
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
  }
});

controller.hears('.*', 'direct_mention,direct_message', (bot, message) => {
  var { text, user } = message;
  console.log(`Received unhandled message from User ${user}:\n${text}`);

  // Ignore if reply is in a thread. Hack to work around infinite bot loops.
  if (_.has(message.event, 'parent_user_id')) return;

  bot.replyInThread(message, 'Pardon me, but I do not understand.');
});

let verifyPayload = async (data) => {
  const response = await fetch('https://slack.hosted.hackclub.com', {
    method: 'post',
    body: data
  });
  const responseData = await response.text();
  const status = await response.status;

  console.log("Data: " + responseData);
  console.log("Status: " + status)

  return [status, responseData];
};
