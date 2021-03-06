'use strict';

require('dotenv').config();

let GoogleSpreadsheet = require('google-spreadsheet');

// nedb
const DataStore = require('nedb');
const db = new DataStore({ filename: './dataBase/member_list.db', autoload: true });

// cron
const CronJob = require('cron').CronJob;

// expressjs
const express = require('express');
const app = express();

// slack web api
const { WebClient } = require('@slack/web-api');
const token = process.env.SLACK_TOKEN;
const web = new WebClient(token);

// spreadsheet key is the long id in the sheets URL
let doc = new GoogleSpreadsheet(process.env.SHEET_ID);
let sheet;

Array.prototype.diff = function (arr) {
  return this.filter(x => !arr.includes(x));
};

function setAuth () {
  return new Promise(function (resolve, reject) {
    var creds = require(process.env.CRED_PATH);
    doc.useServiceAccountAuth(creds, function (err) {
      if (err) {
        reject(err);
      } else {
        doc.getInfo(function (err, info) {
          if (err) {
            reject(err);
          } else {
            resolve(info.worksheets[0]);
          }
        });
      }
    });
  });
}

function getRows () {
  return new Promise(function (resolve, reject) {
    sheet.getRows({
      'offset': 1,
      'limit': 100,
      'orderby': 'col2'
    }, function (err, rows) {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function RowDB (name, id, dorm,email, lastEdited) {
  const splited = dorm.split(' ');
  const type = splited[0];
  const room = splited[1];
  this.name = name;
  this.id = id;
  this.type = type;
  this.room = room;
  this.email = email;
  this.lastEdited = lastEdited;
}

function getNeccessaryData (rows) {
  rows = rows.filter(row => {
    return row.name !== '' && row.id !== '' && row.dorm !== '' && row.email !== '';
  });
  let ROWS = rows.map(row => {
    return new RowDB(row.name, row.id, row.dorm,row.email, row['app:edited']);
  });
  return ROWS
}

function getCurrentData (query) {
  return new Promise(function (resolve, reject) {
    db.find(query, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

function insertDB (data) {
  return new Promise(function (resolve, reject) {
    db.insert(data, function (err, newDoc) {
      if (err) {
        reject(err);
      } else {
        resolve(newDoc);
      }
    });
  });
}

function removeDB (id) {
  return new Promise(function (resolve, reject) {
    db.remove({ id: id }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(id, ' was removed.');
      }
    });
  });
}

async function initializeDB () {
  const rows = await getRows().catch(err => {
    console.log('An error occured:', err);
  });

  await insertDB(getNeccessaryData(rows)).then(data => {
    console.log('Added: ', data);
  }).catch(err => {
    console.log(err);
  });
  job.start();
}

async function check () {
  let CUR_ROW = await getCurrentData({ id: { $exists: true } }).catch(err => {
    console.log('An error occured:', err);
  });

  const REQ_ROW = await getRows().catch(err => {
    console.log('An error occured:', err);
  });

  if (CUR_ROW[0].lastEdited !== REQ_ROW[0]['app:edited']) {
    // Check for new member
    const currentMemberID = CUR_ROW.map(member => {
      return member.id;
    });
    const reqMemberID = REQ_ROW.map(member => {
      return member.id;
    });

    const memberAdded = reqMemberID.diff(currentMemberID);
    const memberRemoved = currentMemberID.diff(reqMemberID);

    if (memberAdded.length) {
      const memberToAdd = memberAdded.map(id => {
        return REQ_ROW.filter(member => {
          return member.id === id;
        })[0];
      });
      const newMember = getNeccessaryData(memberToAdd);
      if (newMember.length) {
        insertDB(newMember).then(data => {
          console.log('Added', data);
        }).catch(err => {
          console.log('An error occured:', err);
        });
      }
    }
    if (memberRemoved.length) {
      memberRemoved.forEach(id => {
        removeDB(id).then(msg => {
          console.log(msg, 'was removed.');
        }).catch(err => {
          console.log('An error occured:', err);
        });
      });
    }

    // Check for moved member
    const memberDetail = currentMemberID.diff(memberRemoved).map(id => {
      return [CUR_ROW.filter(member => {
        return member.id === id;
      })[0],
      getNeccessaryData(REQ_ROW).filter(member => {
        return member.id === id;
      })[0]];
    });
    memberDetail.forEach(member => {
      if (member[0].type !== member[1].type || member[0].room !== member[1].room) {
        (async () => {
          await web.chat.postMessage({
            username: 'Dormitory Bot',
            icon_emoji: ':truck:',
            text: `${member[0].name} was moved from Type: ${member[0].type} Room: ${member[0].room} to Type: ${member[1].type} Room: ${member[1].room}`,
            channel: '#random'
          });
        })();

        db.update({ id: member[0].id }, { $set: { type: member[1].type } }, function (err) {
          if (err) {
            console.log('An error occured:', err);
          }
        });

        db.update({ id: member[0].id }, { $set: { room: member[1].room } }, function (err) {
          if (err) {
            console.log('An error occured:', err);
          }
        });
      }
    });
  }
}

async function start () {
  sheet = await setAuth();
  const data = await getCurrentData({}).catch(err => {
    console.log('An error occured:', err);
  });
  if (!data.length) {
    initializeDB();
  } else {
    job.start();
  }
}

const job = new CronJob('0 */1 * * * *', function () {
  check();
});

start();

app.get('/', async (req, res) => {
  res.send(await getCurrentData({}).catch(err => {
    res.end('An error occured:', err);
  }));
});

app.get('/:target', async (req, res) => {
  res.send(await getCurrentData({ id: req.params.target }));
});

app.listen(process.env.PORT);
