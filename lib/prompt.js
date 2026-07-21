'use strict';

// Tiny interactive prompt helpers for the setup wizard. No dependencies.
const readline = require('readline');

function ask(question, opts) {
  opts = opts || {};
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = opts.defaultValue !== undefined ? ` (${opts.defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(question + suffix + ' ', (ans) => {
      rl.close();
      let v = (ans || '').trim();
      if (!v && opts.defaultValue !== undefined) v = opts.defaultValue;
      if (opts.choices) {
        const choiceNumber = Number.parseInt(v, 10);
        if (Number.isInteger(choiceNumber) && choiceNumber >= 1 && choiceNumber <= opts.choices.length) {
          return resolve(opts.choices[choiceNumber - 1]);
        }
        const match = opts.choices.find((c) => c.toLowerCase() === v.toLowerCase());
        if (match) return resolve(match);
        return resolve(opts.choices[0]); // fall back to first
      }
      if (opts.boolean) return resolve(/^(y|yes|true|1)$/i.test(v));
      if (opts.validate) {
        try { opts.validate(v); } catch (e) { console.log('  \x1b[33m!\x1b[0m ' + e.message); return resolve(ask(question, opts)); }
      }
      resolve(v);
    });
  });
}

function choose(question, choices) {
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}`));
  return ask(question + ` [1-${choices.length}]`, { choices });
}

module.exports = { ask, choose };
