import Airtable from 'airtable';
import _ from 'lodash';
import { readFileSync } from 'fs';

const rawData = readFileSync('data.json');
const data = JSON.parse(rawData);

const base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY
}).base(process.env.AIRTABLE_BASE);

const invoiceReplies = {};


// Unpacks controllers object to include all of the functions from controllers.js
Object.entries(require('src/controllers.js')).forEach(([name, exported]) => global[name] = exported);

// Unpacks utils object to include all of the functions from utils.js
Object.entries(require('src/utils.js')).forEach(([name, exported]) => global[name] = exported);

console.log('Booting bank bot');




