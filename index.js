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

var transfer = (bot, channelType, user, target, amount, note, replyCallback) => {

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
            text: `<@${user}> | ${amount} | ${replyNote}`
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

// @bot give @zrl 100 --> Gives 100gp from my account to zrl's
controller.hears(/give\s+<@([A-z|0-9]+)>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/i, 'direct_mention,direct_message,bot_message', (bot, message) => {
  // console.log(message)
  var {
    text,
    user,
    event
  } = message

  console.log(`Processing give request from ${user}`)
  console.log(message)

  var target = message.match[1]
  var amount = message.match[2]
  var note = message.match[3] || ''

  var replyCallback = text => bot.replyInThread(message, text)

  transfer(bot, event['channel_type'], user, target, amount, note, replyCallback)
})

controller.on('slash_command', (bot, message) => {
  var {
    command,
    text,
    user_id
  } = message
  var user = user_id
  console.log(`Slash command received from ${user_id}: ${text}`)
  console.log(message)


  if (message.channel_id == process.env.SLACK_SELF_ID) {
    bot.replyPublic(message, "Just fyi... You're talking to me already... no need for slash commands to summon me!")
  } else {
    if (command == '/give') {
      var pattern = /<@([A-z|0-9]+)\|.+>\s+([0-9]+)(?:gp)?(?:\s+for\s+(.+))?/
      var match = pattern.exec(text)
      if (match) {
        var target = match[1]
        var amount = match[2]
        var note = match[3] || ''

        var replyCallback = text => bot.replyPublic(message, text)

        transfer(bot, 'public', user_id, target, amount, note, replyCallback)
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
            `You have ${balance}gp in your account, sirrah.` :
            `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`
          bot.replyPublic(message, reply)
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