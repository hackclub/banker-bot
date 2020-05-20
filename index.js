var Botkit = require('botkit');
var Bottleneck = require('bottleneck');
var Airtable = require('airtable');
var _ = require('lodash');
var fs = require('fs');

var rawData = fs.readFileSync('data.json');
var data = JSON.parse(rawData);

var base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY
}).base(process.env.AIRTABLE_BASE);

var redisConfig = {
  url: process.env.REDISCLOUD_URL
};
var redisStorage = require('botkit-storage-redis')(redisConfig);

var startBalance = 0;

var invoiceReplies = {};

console.log('Booting bank bot');

async function createBalance(user) {
  // The function is used to instantiate new users
  console.log(`Creating balance for User ${user}`);
  return new Promise((resolve, reject) => {
    base('bank').create(
      {
        User: user,
        Balance: startBalance
      },
      function (err, record) {
        if (err) {
          console.error(err);
          resolve(null)
        }
        console.log(`New balance created for User ${user}`);
        resolve(record)
      }
    );
  })
}
async function setBalance(id, amount, user, cb = () => { }) {
  console.log(`Changing balance for Record ${id} by ${amount}`);
  getBalance(user, bal => {
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
  })
}

async function getOrCreateBankUser(user) {
  // This function gets the bank user's record from airtable
  console.log(`Retrieving balance for User ${user}`);
  const result = await new Promise((resolve, reject) => {
    base('bank')
      .select({
        filterByFormula: `User = "${user}"`
      })
      .firstPage(function page(err, records) {
        if (err) {
          console.error(err);
          resolve(null)
        }

        if (records.length == 0) {
          console.log(`No balance found for User ${user}.`);
          resolve(createBalance(user));
        } else {
          var record = records[0];
          var balance = record.fields['Balance'];
          console.log(`Balance for User ${user} is ${balance}`);
          resolve(record)
        }
      })
  })

  return result
}

function getBalance(user, cb) {
  console.log(`Retrieving balance for User ${user}`);

  var balancePromise = new Promise((resolve, reject) => {
    base('bank')
      .select({
        filterByFormula: `User = "${user}"`
      })
      .firstPage(function page(err, records) {
        if (err) {
          console.error(err);
          resolve(null)
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
          resolve({balance, record})
        }
      });
  })

  if (cb && typeof cb == "function") {
    balancePromise.then(result => {

      cb(balance, record);
    })
  } else {
    return balancePromise
  }
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

var invoice = async (
  bot,
  sender,
  recipient,
  amount,
  note,
  replyCallback,
) => {
  if (sender == recipient) {
    console.log(`${sender} attempting to invoice theirself`);
    replyCallback(`What are you trying to pull here, <@${sender}>?`);

    return;
  }

  var replyNote = note ? ` for "${note}".` : '.';

  replyCallback(`I shall invoice <@${recipient}> ${amount}gp` + replyNote);

  var invRecord = await createInvoice(sender, recipient, amount, replyNote);

  invoiceReplies[invRecord.id] = replyCallback;

  bot.say({
    user: '@' + recipient,
    channel: '@' + recipient,
    text: `Good morrow hackalacker. <@${sender}> has just sent you an invoice of ${amount}gp${replyNote}
       Reply with "@banker pay ${invRecord.id}".`
  });
};

var txRateLimiter = new Bottleneck({
  maxConcurrent: 1
})
function transfer () {
  return await txRateLimiter.schedule(() => transferJob.apply(null, arguments))
}
var transferJob = async (
  bot,
  channelType,
  user,
  target,
  amount,
  note,
  replyCallback,
  ts,
  channelid
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
      console.log(`Adding ${amount} to ${target}`)
      getBalance(target, (targetBalance, targetRecord) => {
        setBalance(userRecord.id, - amount, user);
        // Treats targetBalance+amount as a string concatenation. WHY???
        setBalance(targetRecord.id, - (-amount), target);

        var replyNote = note ? ` for "${note}".` : '.';

        replyCallback(
          `I shall transfer ${amount}gp to <@${target}> immediately` +
          replyNote,
          true
        );

        var isPrivate = false;

        if (channelType == 'im') {
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `Good morrow hackalacker. <@${user}> has just transferred ${amount}gp to your account${replyNote}`
          });

          isPrivate = true;
        } else if (data.bots.includes(target)) {
          // send clean, splittable data string
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `$$$ | <@${user}> | ${amount} | ${replyNote} | ${channelid} | ${ts}`
          });
        }

        logTransaction(user, target, amount, note, true, '', isPrivate);
      });
    }
  });
};

console.log('Booting banker bot');

var controller = Botkit.slackbot({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  clientSigningSecret: process.env.SLACK_CLIENT_SIGNING_SECRET,
  scopes: ['bot', 'chat:write:bot'],
  storage: redisStorage
});

controller.setupWebserver(process.env.PORT, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);
  controller.createOauthEndpoints(controller.webserver);
});

// @bot balance --> Returns my balance
// @bot balance @zrl --> Returns zrl's balance
var balancePattern = /^balance(?:\s+<@([A-z|0-9]+)>)?/i;
controller.hears(
  balancePattern.source,
  'direct_mention,direct_message,bot_message',
  (bot, message) => {
    var { text, user } = message;
    var captures = balancePattern.exec(text);
    var target = captures[1] || user;

    console.log(
      `Received balance request from User ${user} for User ${target}`
    );
    console.log(message);

    getBalance(target, balance => {
      var reply =
        user == target
          ? `You have ${balance}gp in your account, hackalacker.`
          : `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`;
      bot.replyInThread(message, reply);
    });
  }
);

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
      Private: p
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

function pullFromLedger() {
  txFormulas = [
    '[DATETIME_DIFF(NOW(), Timestamp) < 60 * 60 * 24', // created within 24 hours of now
    'Success = 1',
    `OR(From=${userID}, To=${userID})`
  ]
  base('ledger').select({
    filterByFormula: `AND(${txFormulas.join(', ')})`
  })
}

// log invoice on airtable
function createInvoice(sender, recipient, amount, note) {
  return new Promise((resolve, reject) => {
    base('invoices').create(
      {
        From: sender,
        To: recipient,
        Amount: parseInt(amount),
        Reason: note
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

    var replyCallback = text => bot.replyInThread(message, text);

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

controller.hears(
  /invoice\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i,
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

    var replyCallback = text => bot.replyInThread(message, text);
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

controller.hears(
  /pay\s+([A-z|0-9]+)/i,
  'direct_mention,direct_message,bot_message',
  async (bot, message) => {
    var { text, user, event, ts, channel } = message;
    if (message.thread_ts) {
      ts = message.thread_ts;
    }
    if (message.type == 'bot_message' && !data.bots.includes(user)) {
      // don't reply to bot users not in the whitelist
      return;
    }

    console.log(`Processing invoice payment from ${user}`);

    var id = message.match[1];
    var invRecord = await getInvoice(id);

    if (invRecord.fields['Paid']) {
      bot.replyInThread(message, "You've already paid this invoice!");
      return
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

  switch(command) {
    case '/give':
      var pattern = /<@([A-z|0-9]+)\|.+>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/;
      var match = pattern.exec(text);
      if (match) {
        var target = match[1];
        var amount = match[2];
        var note = match[3] || '';

        var replyCallback = text =>
          bot.replyPublicDelayed(message, {
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: text
                }
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Transferred by <@${user_id}>`
                  }
                ]
              }
            ]
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
      return
    case '/balance':
      var pattern = /(?:<@([A-z|0-9]+)\|.+>)?/i;
      var match = pattern.exec(text);
      if (match) {
        var target = match[1] || user;
        console.log(
          `Received balance request from User ${user} for User ${target}`
        );
        getBalance(target, balance => {
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
                  text: reply
                }
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Requested by <@${user}>`
                  }
                ]
              }
            ]
          });
        });
      }
      return
    case '/stateofgp':
    case '/invoices':
    case '/transactions':
      // show transactions to & from user in past 24 hours. if none, find last 5 transactions
  }

controller.hears('.*', 'direct_mention,direct_message', (bot, message) => {
  var { text, user } = message;
  console.log(`Received unhandled message from User ${user}:\n${text}`);

  // Ignore if reply is in a thread. Hack to work around infinite bot loops.
  if (_.has(message.event, 'parent_user_id')) return;

  bot.replyInThread(message, 'Pardon me, but I do not understand.');
});
