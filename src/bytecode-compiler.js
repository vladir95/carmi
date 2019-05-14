const {
  Expr,
  Token,
  Setter,
  Expression,
  SetterExpression,
  SpliceSetterExpression,
  TokenTypeData,
  Clone
} = require('./lang');
const _ = require('lodash');
const SimpleCompiler = require('./simple-compiler');
const {searchExpressions} = require('./expr-search');
const {exprHash} = require('./expr-hash');

const enums = require('./bytecode/bytecode-enums');

// const {flatbuffers} = require('flatbuffers');
// const {CarmiBytecode} = require('../flatbuffers/bytecode_generated');
// const {ValueType} = CarmiBytecode;

const maxInlineNumber = 32767;
const minInlineNumber = 0;

function embeddedVal(type, val) {
  if (typeof type !== 'number' || typeof val !== 'number' || type < 0 || type > enums.nonVerbs) {
    throw new Error(`illegal value, ${type}, ${val}`);
  }
  return (val << 5) + type;
}

function canInlineNumber(val) {
  return val >= minInlineNumber && val < maxInlineNumber;
}

function setToMap(src) {
  const res = new Map();
  src.forEach(val => res.set(val, res.size));
  return res;
}

function str2ab_array(str) {
  if (str.length % 2 === 1) {
    str += ' ';
  }
  const buf = new ArrayBuffer(str.length * 2);
  const bufView = new Uint16Array(buf);
  for (let i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return bufView;
}

function concatBuffers(...buffers) {
  // buffers = [buffers[0]]
  const offsetsSize = 4 * (buffers.length + 1);
  const totalSize = _.sum(buffers.map(buf => buf.byteLength)) + offsetsSize;

  const out = new Buffer(totalSize);

  let offset = 4;
  let totalLength = offsetsSize;
  out.writeUInt32LE(offsetsSize, 0);
  for (let i = 0; i < buffers.length; i++) {
    totalLength += buffers[i].byteLength;
    out.writeUInt32LE(totalLength, offset);
    offset += 4;
  }
  buffers.forEach(buf => {
    for (let i = 0; i < buf.length; i++) {
      if (buf instanceof Uint32Array) {
        out.writeUInt32LE(buf[i], offset);
        offset += 4;
      } else {
        out.writeUInt16LE(buf[i], offset);
        offset += 2;
      }
    }
  });
  return out;
}

class BytecodeCompiler extends SimpleCompiler {
  constructor(model, options) {
    options = {...options, disableHelperFunctions: true};
    super(model, options);
  }
  compile() {
    const realGetters = [];
    Object.keys(this.getters).forEach(name => {
      const index = this.topLevelToIndex(name);
      if (typeof index === 'number') {
        realGetters[index] = name;
      }
    });
    const countTopLevels = realGetters.length;
    const exprsFromHash = {};
    searchExpressions(e => {
      if (!(e instanceof Expression)) {
        return;
      }
      const hash = exprHash(e);
      e[0].$hash = hash;
      exprsFromHash[hash] = exprsFromHash[hash] || e;
    }, Object.values(this.getters));
    const exprsHashToIndex = new Map();
    const stringsSet = new Set();
    stringsSet.add(''); // the zero constant string is the empty string
    const numbersSet = new Set();
    const addConst = t => {
      if (typeof t === 'string') {
        stringsSet.add(t);
      } else if (typeof t === 'number' && !canInlineNumber(t)) {
        numbersSet.add(t);
      }
    };
    Object.keys(this.getters).forEach(t => {
      if (this.options.debug || t[0] !== '$') {
        stringsSet.add(t);
      }
    });
    Object.keys(this.setters).forEach(t => stringsSet.add(t));
    Object.values(this.setters).forEach(setter => setter.forEach(addConst));
    searchExpressions(e => {
      if (e[0].$type === 'get' && e[2] instanceof Token && e[2].$type === 'topLevel') {
        e[1] = this.topLevelToIndex(e[1]);
      }
      e.forEach(addConst);
    }, Object.values(this.getters));
    Object.values(this.setters).forEach(s => s.forEach(addConst));
    Object.keys(exprsFromHash).forEach(hash => {
      exprsHashToIndex.set(hash, exprsHashToIndex.size);
    });
    // console.log(exprsHashToIndex.size, stringsSet.size, numbersSet.size, Object.keys(this.getters).length);
    const stringsMap = setToMap(stringsSet);
    const numbersMap = setToMap(numbersSet);
    const expressionsHashToIndex = {};
    Object.keys(exprsFromHash).forEach((hash, index) => expressionsHashToIndex[hash] = index);
    const taggedIdToIndex = {};
    const tracking = [];
    const trackingOffsetByExprIndex = {};

    searchExpressions(e => {
      if (e instanceof Expression) {
        taggedIdToIndex[e[0].$id] = exprsHashToIndex.get(exprHash(e));
      }
    }, Object.values(this.getters));
    // console.log(taggedIdToIndex);
    // searchExpressions(e => {
    //   const hash = exprHash(e);
    //   const index = exprsHashToIndex.get(hash);
    //   if (!e[0].$path || trackingOffsetByExprIndex.hasOwnProperty(index)) {
    //     return;
    //   }
    //   e[0].$path.forEach((val, key) => console.log(JSON.stringify(val), JSON.stringify(key)));
    //   console.log('----')
    // }, Object.values(this.getters));

    const stringsAndNumbers = JSON.stringify({$strings: Array.from(stringsSet), $numbers: Array.from(numbersSet)});
    const constsBuffer = str2ab_array(stringsAndNumbers);
    const countOfTopLevels = Object.keys(this.getters).length;
    const countOfExpressions = Object.keys(exprsFromHash).length;
    const lengthOfAllExpressions = _.sum(Object.values(exprsFromHash).map(e => e.length));
    const header = new Uint32Array(3);
    header[0] = countOfTopLevels;
    header[1] = countOfExpressions;
    header[2] = lengthOfAllExpressions;
    const topLevelNames = new Uint32Array(countOfTopLevels);
    const topLevelExpressions = new Uint32Array(countOfTopLevels);
    _.range(countTopLevels).forEach(i => {
      let name = '';
      if (this.options.debug || realGetters[i][0] !== '$') {
        name = realGetters[i];
      }
      topLevelNames[i] = stringsMap.get(name);
      topLevelExpressions[i] = exprsHashToIndex.get(exprHash(this.getters[realGetters[i]]));
    });
    // console.log(exprsHashToIndex);
    let exprOffset = 0;
    const expressionsOffsets = new Uint32Array(countOfExpressions);
    const expressions = new Uint32Array(lengthOfAllExpressions);

    function convertToEmbeddedValue(val) {
      if (typeof val === 'string') {
        return embeddedVal(enums.$stringRef, stringsMap.get(val));
      } else if (typeof val === 'number') {
        return canInlineNumber(val) ?
          embeddedVal(enums.$numberInline, val) :
          embeddedVal(enums.$numberRef, numbersMap.get(val));
      } else if (typeof val === 'boolean') {
        return embeddedVal(enums.$booleanInline, val ? 1 : 0);
      } else if (val instanceof Token) {
        return embeddedVal(enums[`$${val.$type}`], 0);
      } else if (val instanceof Expression) {
        return embeddedVal(enums.$expressionRef, expressionsHashToIndex[exprHash(val)]);
      }
    }

    Object.keys(exprsFromHash).forEach((hash, index) => {
      const e = exprsFromHash[hash];
      const verb = enums[`$${e[0].$type}`] << 16;
      expressions[exprOffset] = verb + e.length;
      // console.log(e[0].$type, expressions[exprOffset], JSON.stringify(e));
      e.slice(1)
        .map(convertToEmbeddedValue)
        .forEach((val, indexInExpr) => {
          expressions[exprOffset + 1 + indexInExpr] = val;
        });
      expressionsOffsets[index] = exprOffset;
      exprOffset += e.length;
    });
    const settersSize = _.sum(Object.keys(this.setters).map(key => this.setters[key].length + 2));
    const settersBuffer = new Uint32Array(settersSize);
    let settersOffset = 0;
    Object.keys(this.setters).forEach(key => {
      const setter = this.setters[key];
      const type = enums[`$${setter.setterType()}`] << 16;
      settersBuffer[settersOffset++] = type + setter.length;
      settersBuffer[settersOffset++] = stringsMap.get(key);
      setter.map(convertToEmbeddedValue).forEach(val => {
        settersBuffer[settersOffset++] = val
      });
    });


    // console.log({
    //   header,
    //   topLevelExpressions,
    //   topLevelNames,
    //   expressionsOffsets,
    //   expressions,
    //   constsBuffer,
    //   lengthOfAllExpressions
    // });
    const outputArray = concatBuffers(
      header,
      topLevelExpressions,
      topLevelNames,
      expressionsOffsets,
      expressions,
      settersBuffer,
      constsBuffer
    );
    return outputArray;
  }
}

module.exports = BytecodeCompiler;