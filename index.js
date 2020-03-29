var Botkit = require('botkit')
var Airtable = require('airtable')
var _ = require('lodash')
var fs = require("fs");

var rawData = fs.readFileSync("data.json");
var data = JSON.parse(rawData);

var base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY
}).base(process.env.AIRTABLE_BASE);

var redisConfig = {
  url: process.env.REDISCLOUD_URL
}
var redisStorage = require('botkit-storage-redis')(redisConfig)

var startBalance = 0

// maps invoice ids, e.g. "rec2jrE82X7v2J9Rp" to callbacks you
// can pass a message to to have that call back log the fulfillment
// of the invoice into the slack thread from which the invoice originated.
// 
// note that this isn't serialized; if the banker restarts in the midst of
// a transaction, then even if the invoice is payed, the banker will not reply
// in the thread from which the invoice originated, although the transaction
// will still be logged, the funds will still be transferred, and DMs will
// still be sent to the individual receiving the funds.
var invoiceReplies = {};

console.log("Booting bank bot")

function createBalance(user, cb = () => {}) {
  console.log(`Creating balance for User ${user}`)

  base('bank').create({
    "User": user,
    "Balance": startBalance
  }, function (err, record) {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`New balance created for User ${user}`)
    // console.log(record)
    cb(startBalance, record)
  });
}

function setBalance(id, balance, cb = () => {}) {
  console.log(`Setting balance for Record ${id} to ${balance}`)

  base('bank').update(id, {
    "Balance": balance
  }, function (err, record) {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Balance for Record ${id} set to ${balance}`)
    cb(balance, record)
  })
}

function getBalance(user, cb = () => {}) {
  console.log(`Retrieving balance for User ${user}`)

  base('bank').select({
    filterByFormula: `User = "${user}"`
  }).firstPage(function page(err, records) {
    if (err) {
      console.error(err)
      return
    }

    if (records.length == 0) {
      console.log(`No balance found for User ${user}.`)
      createBalance(user, cb)
    } else {
      var record = records[0]
      var fields = record.fields
      var balance = fields['Balance']
      console.log(`Balance for User ${user} is ${balance}`)
      console.log(fields)
      cb(balance, record)
    }
  })
}

function getInvoice(id) {
  return new Promise((resolve, reject) => {
    base('invoices').find(id, (err, record) => {
      if (err) {
        console.error(err)
        reject(err)
      }
      resolve(record)
    })
  })
}

console.log("Booting banker bot")

var controller = Botkit.slackbot({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  clientSigningSecret: process.env.SLACK_CLIENT_SIGNING_SECRET,
  scopes: ['bot', 'chat:write:bot'],
  storage: redisStorage
});

controller.setupWebserver(process.env.PORT, function (err, webserver) {
  controller.createWebhookEndpoints(controller.webserver)
  controller.createOauthEndpoints(controller.webserver)
});

function matchData(str, pattern, keys, obj = {}) {
  var match = pattern.exec(str)

  if (match) {
    var text = _.head(match)
    var vals = _.tail(match)
    var zip = _.zipObject(keys, vals)
    _.defaults(obj, zip)
    return obj
  }

  return null
}

// @bot balance --> Returns my balance
// @bot balance @zrl --> Returns zrl's balance
var balancePattern = /^balance(?:\s+<@([A-z|0-9]+)>)?/i
controller.hears(balancePattern.source, 'direct_mention,direct_message,bot_message', (bot, message) => {
  var {
    text,
    user
  } = message
  var captures = balancePattern.exec(text)
  var target = captures[1] || user

  console.log(`Received balance request from User ${user} for User ${target}`)
  console.log(message)

  getBalance(target, (balance) => {
    var reply = user == target ?
      `You have ${balance}gp in your account, sirrah.` :
      `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`
    bot.replyInThread(message, reply)
  })
})

var invoice = async (bot, channelType, sender, recipient, amount, note, replyCallback, ts, channelid) => {
  if (sender == recipient) {
    console.log(`${sender} attempting to invoice theirself`)
    replyCallback(`What are you trying to pull here, <@${sender}>?`)

    return
  }

  replyCallback(`I shall invoice <@${recipient}> ${amount}gp for "${note}"`)

  var invRecord = await createInvoice(sender, recipient, amount, note)

  var isPrivate = false

  invoiceReplies[invRecord.id] = replyCallBack;

  bot.say({
    user: '@' + recipient,
    channel: '@' + recipient,
    text: `Good morrow sirrah. <@${sender}> has just sent you an invoice of ${amount}gp for "${note}". Reply with "@banker pay ${invRecord.id}".`
  })
}

var transfer = (bot, channelType, user, target, amount, note, replyCallback,ts,channelid) => {

  if (user == target) {
    console.log(`${user} attempting to transfer to theirself`)
    replyCallback(`What are you trying to pull here, <@${user}>?`)

    logTransaction(user, target, amount, note, false, "Self transfer")
    return
  }

  getBalance(user, (userBalance, userRecord) => {
    if (userBalance < amount) {
      console.log(`User has insufficient funds`)
      replyCallback(`Regrettably, you only have ${userBalance}gp in your account.`)

      logTransaction(user, target, amount, note, false, "Insufficient funds")
    } else {
      getBalance(target, (targetBalance, targetRecord) => {
        setBalance(userRecord.id, userBalance - amount)
        // Treats targetBalance+amount as a string concatenation. WHY???
        setBalance(targetRecord.id, targetBalance - (-amount))

        var replyNote = !note.length ? '.' : ` for "${note}"`

        replyCallback(`I shall transfer ${amount}gp to <@${target}> immediately${replyNote}`)

        var isPrivate = false

        if (channelType == 'im') {
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `Good morrow sirrah. <@${user}> has just transferred ${amount}gp to your account${replyNote}`
          })

          isPrivate = true
        } else if (data.bots.includes(target)) {
          // send clean, splittable data string
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `$$$ | <@${user}> | ${amount} | ${replyNote} | ${channelid} | ${ts}`
          })
        }

        logTransaction(user, target, amount, note, true, "", isPrivate)
      })
    }
  })

}

// log transactions in ledger
// parameters: user, target, amount, note, success, log message, private
function logTransaction(u, t, a, n, s, m, p) {
  if (p === undefined)
    p = false

  console.log(parseInt(a))

  base('ledger').create({
    "From": u,
    "To": t,
    "Amount": parseInt(a),
    "Note": n,
    "Success": s,
    "Admin Note": m,
    "Timestamp": Date.now(),
    "Private": p
  }, function (err, record) {
    if (err) {
      console.error(err)
      return
    }
    console.log("New ledger transaction logged: " + record.getId())
  })
}

// log invoice on airtable
function createInvoice(sender, recipient, amount, note) {
  return new Promise((resolve, reject) => {
    base('invoices').create({
      "From": sender,
      "To": recipient,
      "Amount": parseInt(amount),
      "Reason": note
    }, function (err, record) {
      if (err) {
        console.error(err)
        reject(err)
      }
      console.log("New invoice created:", record.getId())
      resolve(record)
    })
  })
}

// @bot give @zrl 100 --> Gives 100gp from my account to zrl's
controller.hears(/give\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i, 'direct_mention,direct_message,bot_message', (bot, message) => {
  
  // console.log(message)
  var {
    text,
    user,
    event,
    ts,
    channel
  } = message
  if (message.thread_ts) {
    ts = message.thread_ts;
  }
  if (message.type == "bot_message" && !(data.bots.includes(user))) return

  console.log(`Processing give request from ${user}`)
  console.log(message)

  var target = message.match[1]
  var amount = message.match[2]
  var note = message.match[3] || ''

  var replyCallback = text => bot.replyInThread(message, text)

  transfer(bot, event['channel_type'], user, target, amount, note, replyCallback,ts,channel)
})

// @bot invoice @zrl 100 for stickers --> Creates invoice for 100gp & notifies @zrl

controller.hears(/invoice\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i, 'direct_mention,direct_message,bot_message', (bot, message) => {
  var {
    text,
    user,
    event,
    ts,
    channel
  } = message
  if (message.thread_ts) {
    ts = message.thread_ts;
  }
  if (message.type == "bot_message" && !(data.bots.includes(user))) return

  console.log(`Processing invoice request from ${user}`)

  var target = message.match[1]
  var amount = message.match[2]
  var note = message.match[3] || ''

  var replyCallback = text => bot.replyInThread(message, text)
  invoice(bot, event['channel_type'], user, target, amount, note, replyCallback, ts, channel)
})

// @bot pay rec182yhe902 --> pays an invoice

controller.hears(/pay\s+([A-z|0-9]+)/i, 'direct_mention,direct_message,bot_message', async (bot, message) => {
  var {
    text,
    user,
    event,
    ts,
    channel
  } = message
  if (message.thread_ts) {
    ts = message.thread_ts
  }
  if (message.type == "bot_message" && !(data.bots.includes(user))) return

  console.log(`Processing invoice payment from ${user}`)

  var id = message.match[1]
  var invRecord = await getInvoice(id)

  if (invRecord.fields['Paid']) {
    bot.replyInThread(message, "You've already paid this invoice!")
  }
  var amount = invRecord.fields['Amount']
  var target = invRecord.fields['From']
  var note = `for invoice ${invRecord.id}`
  var replyCallback = text => {
    bot.replyInThread(message, text)
    if (typeof invoiceReplies[id] == "function") {
      invoiceReplies[id](text)
    }
  };

  transfer(bot, channel.type, user, target, amount, note, replyCallback, ts, channel)
})

controller.on('slash_command', (bot, message) => {
  var {
    command,
    text,
    user_id,
    ts,
    channel
  } = message
  var user = user_id
  console.log(`Slash command received from ${user_id}: ${text}`)
  console.log(message)

  bot.replyAcknowledge()

  if (message.channel_id == process.env.SLACK_SELF_ID) {
    bot.replyPublicDelayed(message, "Just fyi... You're talking to me already... no need for slash commands to summon me!")
  } else {
    if (command == '/give') {
      var pattern = /<@([A-z|0-9]+)\|.+>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/
      var match = pattern.exec(text)
      if (match) {
        var target = match[1]
        var amount = match[2]
        var note = match[3] || ''

        var replyCallback = text => bot.replyPublicDelayed(message, text)

        transfer(bot, 'public', user_id, target, amount, note, replyCallback,ts,channel)
      } else {
        bot.replyPrivateDelayed(message, "I do not understand! Please type your message as `/give @user [positive-amount]gp for [reason]`")
      }
    }

    if (command == '/balance') {
      var pattern = /(?:<@([A-z|0-9]+)\|.+>)?/i
      var match = pattern.exec(text)
      if (match) {
        var target = match[1] || user
        console.log(`Received balance request from User ${user} for User ${target}`)
        getBalance(target, (balance) => {
          var reply = user == target ?
            `Ah yes, <@${target}> (${target}). You have ${balance}gp in your account, sirrah.` :
            `Ah yes, <@${target}> (${target})—they have ${balance}gp.`
          bot.replyPublicDelayed(message, reply)
        })
      }
    }
  }

})

controller.hears('.*', 'direct_mention,direct_message', (bot, message) => {
  var {
    text,
    user
  } = message
  console.log(`Received unhandled message from User ${user}:\n${text}`)

  // Ignore if reply is in a thread. Hack to work around infinite bot loops.
  if (_.has(message.event, 'parent_user_id')) return

  bot.replyInThread(message, 'Pardon me, but I do not understand.')
})
