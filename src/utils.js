const startBalance = 0;

const createBalance = (user, cb = () => {}) => {
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
};

const setBalance = (id, amount, user, cb = () => {}) => {
  
  console.log(`Changing balance for Record ${id} by ${amount}`);

  var interval = setInterval(() => {
    console.log(`Global variable is ${globalChanges}`);
    if (!globalChanges) {
      globalChanges = true;
      getBalance(user, (bal) => {
        base('bank').update(
          id,
          {
            Balance: bal + amount,
          },
          (err, record) => {
            clearInterval(interval)
            arrayIntervals.shift();
            globalChanges = false;
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
  }, 1000)
};

const getBalance = (user, cb = () => {}) => {
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
};

const getInvoice = (id) => {
  return new Promise((resolve, reject) => {
    base('invoices').find(id, (err, record) => {
      if (err) {
        console.error(err);
        reject(err);
      }
      resolve(record);
    });
  });
};

const matchData = (str, pattern, keys, obj = {}) => {
  var match = pattern.exec(str);

  if (match) {
    var text = _.head(match);
    var vals = _.tail(match);
    var zip = _.zipObject(keys, vals);
    _.defaults(obj, zip);
    return obj;
  }

  return null;
};

const invoice = async (
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

  var replyNote = note ? ` for "${note}".` : '.';

  replyCallback(`I shall invoice <@${recipient}> ${amount}gp` + replyNote);

  var invRecord = await createInvoice(sender, recipient, amount, replyNote);

  var isPrivate = false;

  invoiceReplies[invRecord.id] = replyCallback;

  bot.say({
    user: '@' + recipient,
    channel: '@' + recipient,
    text: `Good morrow sirrah. <@${sender}> has just sent you an invoice of ${amount}gp${replyNote}
            Reply with "@banker pay ${invRecord.id}".`,
  });
};

const transfer = (
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
    console.log(`${user} attempting to transfer to themself`);
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
        //"Treats targetBalance+amount as a string concatenation. WHY???"
        setBalance(userRecord.id, -amount, user);
        setBalance(targetRecord.id, -(-amount), target);

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
            text: `Good morrow sirrah. <@${user}> has just transferred ${amount}gp to your account${replyNote}`,
          });

          isPrivate = true;
        } else if (data.bots.includes(target)) {
          // send clean, splittable data string
          bot.say({
            user: '@' + target,
            channel: '@' + target,
            text: `$$$ | <@${user}> | ${amount} | ${replyNote} | ${channelid} | ${ts}`,
          });
        }

        logTransaction(user, target, amount, note, true, '', isPrivate);
      });
    }
  });
};

// log transactions in ledger
// parameters: user, target, amount, note, success, log message, private
const logTransaction = (
  user,
  target,
  amount,
  note,
  success,
  logMessage,
  private
) => {
  if (private === undefined) private = false;

  console.log(parseInt(amount));

  base('ledger').create(
    {
      From: user,
      To: target,
      Amount: parseInt(amount),
      Note: note,
      Success: success,
      'Admin Note': logMessage,
      Timestamp: Date.now(),
      Private: private,
    },
    function (err, record) {
      if (err) {
        console.error(err);
        return;
      }
    }
  );
};

// log invoice on airtable
const createInvoice = (sender, recipient, amount, note) => {
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
};

export default {
  createBalance,
  setBalance,
  getBalance,
  getInvoice,
  matchData,
  setBalance,
};
