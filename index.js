var Botkit = require('botkit')
var Airtable = require('airtable')
var _ = require('lodash')

var base = new Airtable({apiKey: process.env.AIRTABLE_KEY}).base(process.env.AIRTABLE_BASE);

var redisConfig = {
  url: process.env.REDISCLOUD_URL
}
var redisStorage = require('botkit-storage-redis')(redisConfig)

var startBalance = 100

console.log("Booting bank bot")

function createBalance(user, cb = () => {}) {
  console.log(`Creating balance for User ${user}`)
  
  base('bank').create({
    "User": user,
    "Balance": startBalance
  }, function(err, record) {
      if (err) { console.error(err); return; }
      console.log(`New balance created for User ${user}`)
      // console.log(record)
      cb(100, record)
  });
}

function setBalance(id, balance, cb = () => {}) {
  console.log(`Setting balance for Record ${id} to ${balance}`)

  base('bank').update(id, {
    "Balance": balance
  }, function(err, record) {
    if (err) { console.error(err); return; }
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
    }
    else {
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

controller.setupWebserver(process.env.PORT, function(err,webserver) {
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

var bot = controller.spawn({
});

bot.say({
  text: 'Awake',
  channel: '@UDK5M9Y13'
});

// @bot balance --> Returns my balance
// @bot balance @zrl --> Returns zrl's balance
var balancePattern = /^balance(?:\s+<@([A-z|0-9]+)>)?/i
controller.hears(balancePattern.source, 'direct_mention,direct_message', (bot, message) => {
  var {text, user} = message
  var captures = balancePattern.exec(text)
  var target = captures[1] || user
  console.log(`Received balance request from User ${user} for User ${target}`)
  getBalance(target, (balance) => {
    var reply = user == target ?
      `You have ${balance}gp in your account, sirrah.` :
      `Ah yes, User <@${target}> (${target})—they have ${balance}gp.`
    bot.replyInThread(message, reply)
  })
})

const transfer = (message, user, target, amount) => {

  getBalance(user, (userBalance, userRecord) => {
    if (userBalance < amount) {
      console.log(`User has insufficient funds`)
      bot.replyInThread(message, `Regrettably, you only have ${userBalance}gp in your account.`)
    }
    else {
      getBalance(target, (targetBalance, targetRecord) => {
        setBalance(userRecord.id, userBalance-amount)
        // Treats targetBalance+amount as a string concatenation. WHY???
        setBalance(targetRecord.id, targetBalance-(-amount))
        
        bot.replyInThread(message, `I shall transfer ${amount}gp to ${target} immediately.`)

        if (event['channel_type'] == 'im') {
          bot.say({
            user: '@'+target,
            channel: '@'+target,
            text: `Good morrow sirrah. <@${user}> has just transferred ${amount}gp to your account.`
          })
        }
      })
    }
  })

}

// @bot give @zrl 100 --> Gives 100gp from my account to zrl's
var givePattern = /give\s+<@([A-z|0-9]+)>\s+([0-9]+)/i
controller.hears(givePattern.source, 'direct_mention,direct_message', (bot, message) => {
  // console.log(message)
  var {text, user, event} = message

  console.log(`Processing give request from ${user}`)

  var keys = ['target', 'amount']
  var args = matchData(text, givePattern, keys)

  if (args) {
    var {target, amount} = args

    transfer(message, user, target, amount)
  }
  }
})

controller.hears('.*', 'direct_mention,direct_message', (bot, message) => {
  var {text, user} = message
  console.log(`Received unhandled message from User ${user}:\n${text}`)

  // Ignore if reply is in a thread. Hack to work around infinite bot loops.
  if (_.has(message.event, 'parent_user_id')) return

  bot.replyInThread(message, 'Pardon me, but I do not understand.')
})