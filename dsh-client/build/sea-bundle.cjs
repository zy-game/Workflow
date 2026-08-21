#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash: createHash2 } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash: createHash2 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// vendor/dsh-neotui/src/term.js
var import_node_string_decoder = require("node:string_decoder");
function detectKitty(env = process.env) {
  return Boolean(env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "WezTerm" || /kitty/i.test(env.TERM ?? ""));
}
var KEY_NAMES = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4"
};
var TILDE_NAMES = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pgup",
  6: "pgdn",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12"
};
var KITTY_KEY_NAMES = {
  13: "enter",
  9: "tab",
  27: "escape",
  127: "backspace",
  57344: "f1",
  57345: "f2",
  57346: "f3",
  57347: "f4",
  57348: "f5",
  57349: "f6",
  57350: "f7",
  57351: "f8",
  57352: "f9",
  57353: "f10",
  57354: "f11",
  57355: "f12",
  57356: "insert",
  57357: "delete",
  57358: "home",
  57359: "end",
  57360: "pgup",
  57361: "pgdn",
  57362: "up",
  57363: "down",
  57364: "right",
  57365: "left"
};
var Term = class {
  constructor({ input = process.stdin, output = process.stdout, onEvent, onResize, kitty = false } = {}) {
    this.input = input;
    this.output = output;
    this.onEvent = onEvent ?? (() => {
    });
    this.onResize = onResize ?? (() => {
    });
    this.kitty = kitty;
    this.kittyActive = false;
    this.handoff = process.env.DSH_TUI_RESTART_HANDOFF === "1";
    this.escTimer = null;
    this.decoder = new import_node_string_decoder.StringDecoder("utf8");
    this.buf = "";
    this.started = false;
    this.pasteBuf = null;
    this.pasting = false;
    this.dataHandler = (chunk) => this.#feed(this.decoder.write(chunk));
    this.w = output.columns || 80;
    this.h = output.rows || 24;
  }
  start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.dataHandler);
    const o = this.output;
    o.write("\x1B[?1049h");
    if (this.kitty) o.write("\x1B_Ga=d,d=A,q=2\x1B\\");
    o.write("\x1B[?25l");
    o.write("\x1B[5 q");
    o.write("\x1B[?1000h");
    o.write("\x1B[?1002h");
    o.write("\x1B[?1006h");
    o.write("\x1B[?2004h");
    o.write("\x1B[?7l");
    if (this.kitty) {
      o.write("\x1B[>1u");
      o.write("\x1B[?u");
    }
    this.resizeHandler = () => this.#resize();
    process.on("SIGWINCH", this.resizeHandler);
    this.#resize();
  }
  stop() {
    if (!this.started) return;
    this.started = false;
    const o = this.output;
    if (this.kitty) o.write("\x1B_Ga=d,d=A,q=2\x1B\\");
    o.write("\x1B[?7h\x1B[?2004l\x1B[?1006l\x1B[?1002l\x1B[?1000l\x1B[?25h\x1B[0 q\x1B[?1049l");
    if (this.kitty) o.write("\x1B[<u");
    process.off("SIGWINCH", this.resizeHandler);
    this.input.off("data", this.dataHandler);
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    this.buf = "";
    this.pasteBuf = null;
    this.pasting = false;
    this.decoder = new import_node_string_decoder.StringDecoder("utf8");
    this.input.pause();
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(false);
  }
  #resize() {
    const w = this.output.columns || process.stdout.columns || 80;
    const h = this.output.rows || process.stdout.rows || 24;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.onResize(w, h);
    }
  }
  #emit(ev) {
    this.handoff = false;
    this.onEvent(ev);
  }
  /** A lone ESC waits briefly for the rest of its sequence; if nothing
   *  arrives it becomes the standalone Escape key. */
  #armEscFallback() {
    if (this.escTimer) return;
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buf === "\x1B") {
        this.buf = "";
        this.#emit({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
      } else {
        this.#parse();
      }
    }, 30);
  }
  #clearEscFallback() {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }
  #feed(s) {
    if (!s) return;
    this.buf += s;
    this.#parse();
  }
  #parse() {
    const buf = this.buf;
    const PASTE_END = "\x1B[201~";
    let i = 0;
    while (i < buf.length) {
      if (this.pasting) {
        const end = buf.indexOf(PASTE_END, i);
        if (end === -1) {
          let keep = 0;
          for (let k = 1; k < PASTE_END.length; k++) {
            if (buf.length - k >= 0 && buf.endsWith(PASTE_END.slice(0, k))) keep = k;
          }
          this.pasteBuf += buf.slice(i, buf.length - keep);
          i = buf.length - keep;
          break;
        }
        this.pasteBuf += buf.slice(i, end);
        this.pasting = false;
        this.#emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        i = end + PASTE_END.length;
        continue;
      }
      const ch = buf[i];
      if (this.handoff && i === 0 && ch === "[") {
        const tail = /^(?:\[<\d+;\d+;\d+[Mm]|\[\d+(?:;\d+)*u)/.exec(buf.slice(i));
        if (tail) {
          this.handoff = false;
          i += tail[0].length;
          continue;
        }
      }
      if (ch === "\x1B") {
        const next = buf[i + 1];
        if (next !== void 0) this.#clearEscFallback();
        if (next === "[") {
          const r = this.#parseCsi(buf, i + 2);
          if (r === null) break;
          i = r.next;
        } else if (next === "O") {
          const fin = buf[i + 2];
          if (fin === void 0) break;
          const name = KEY_NAMES[fin];
          if (name) this.#emit({ type: "key", name, ctrl: false, alt: false, shift: false });
          i += 3;
        } else if (next === "]") {
          let j = i + 2;
          let terminated = false;
          while (j < buf.length) {
            if (buf[j] === "\x07") {
              terminated = true;
              j++;
              break;
            }
            if (buf[j] === "\x1B" && buf[j + 1] === "\\") {
              terminated = true;
              j += 2;
              break;
            }
            j++;
          }
          if (!terminated) break;
          i = j;
        } else if (next === "P" || next === "X" || next === "^" || next === "_") {
          let j = i + 2;
          let terminated = false;
          while (j < buf.length) {
            if (buf[j] === "\x07") {
              terminated = true;
              j++;
              break;
            }
            if (buf[j] === "\x1B" && buf[j + 1] === "\\") {
              terminated = true;
              j += 2;
              break;
            }
            j++;
          }
          if (!terminated) break;
          i = j;
        } else if (next !== void 0) {
          const cp = next.codePointAt(0);
          if (cp === 13) this.#emit({ type: "key", name: "enter", ctrl: false, alt: true, shift: false });
          else this.#emit({ type: "key", name: "char", key: next.toLowerCase(), text: next, ctrl: false, alt: true, shift: false });
          i += 2;
        } else {
          this.#armEscFallback();
          break;
        }
      } else if (ch === "\r") {
        this.#emit({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
        i++;
      } else if (ch === "\n") {
        this.#emit({ type: "key", name: "char", key: "j", text: "j", ctrl: true, alt: false, shift: false });
        i++;
      } else if (ch === "	") {
        this.#emit({ type: "key", name: "tab", ctrl: false, alt: false, shift: false });
        i++;
      } else if (ch === "\x7F") {
        this.#emit({ type: "key", name: "backspace", ctrl: false, alt: false, shift: false });
        i++;
      } else {
        const cp = ch.codePointAt(0);
        if (cp < 32) {
          if (cp === 0) {
            this.#emit({ type: "key", name: "char", key: " ", text: " ", ctrl: true, alt: false, shift: false });
          } else {
            const key = String.fromCharCode(cp + 96);
            this.#emit({ type: "key", name: "char", key, text: key, ctrl: true, alt: false, shift: false });
          }
          i++;
        } else {
          let j = i;
          while (j < buf.length) {
            const c = buf.codePointAt(j);
            if (c === 27 || c < 32) break;
            j += c > 65535 ? 2 : 1;
          }
          this.#emit({ type: "text", text: buf.slice(i, j) });
          i = j;
        }
      }
    }
    this.buf = buf.slice(i);
  }
  /** Parse CSI starting after "\x1b[". Returns {next} or null when incomplete. */
  #parseCsi(buf, start) {
    let i = start;
    let prefix = "";
    const first = buf[i];
    if (first === "<" || first === ">" || first === "?" || first === "=") {
      prefix = first;
      i++;
    }
    let params = "";
    while (i < buf.length) {
      const c = buf[i];
      const cc = c.charCodeAt(0);
      if (cc >= 48 && cc <= 57 || c === ";" || c === ":" || c === " ") {
        params += c;
        i++;
        continue;
      }
      if (cc >= 64 && cc <= 126) {
        this.#dispatchCsi(prefix, params, c);
        return { next: i + 1 };
      }
      if (cc === 27 || cc < 32) {
        return { next: i };
      }
      return null;
    }
    return null;
  }
  #dispatchCsi(prefix, params, final) {
    if (prefix === "<") {
      this.#mouse(params, final);
      return;
    }
    if (prefix === "?") {
      if (final === "u") {
        const flags = Number(params.split(";")[0] || 0);
        if (flags & 1) this.kittyActive = true;
      }
      return;
    }
    if (prefix === ">") return;
    if (final === "Z") {
      this.#emit({ type: "key", name: "backtab", ctrl: false, alt: false, shift: true });
      return;
    }
    if (final === "u") {
      this.#kittyKey(params);
      return;
    }
    const nums = params.split(";").filter((s) => s !== "").map(Number);
    if (final === "~") {
      if (nums.length >= 3 && nums[0] === 27) {
        const code = nums[2] ?? 0;
        const mod3 = nums[1] ?? 1;
        const ctrl3 = !!(mod3 - 1 & 4), alt3 = !!(mod3 - 1 & 2), shift3 = !!(mod3 - 1 & 1);
        const special = TILDE_NAMES[code];
        if (special) {
          this.#emit({ type: "key", name: special, ctrl: ctrl3, alt: alt3, shift: shift3 });
          return;
        }
        let text = "";
        try {
          text = String.fromCodePoint(code);
        } catch {
          return;
        }
        this.#emit({ type: "key", name: "char", key: text.toLowerCase(), text, ctrl: ctrl3, alt: alt3, shift: shift3 });
        return;
      }
      const [n = 0, mod2 = 1] = nums;
      if (n === 200) {
        this.pasting = true;
        this.pasteBuf = "";
        return;
      }
      if (n === 201) {
        this.pasting = false;
        if (this.pasteBuf !== "") this.#emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        return;
      }
      const name2 = TILDE_NAMES[n];
      if (!name2) return;
      const ctrl2 = !!(mod2 - 1 & 4), alt2 = !!(mod2 - 1 & 2), shift2 = !!(mod2 - 1 & 1);
      this.#emit({ type: "key", name: name2, ctrl: ctrl2, alt: alt2, shift: shift2 });
      return;
    }
    const name = KEY_NAMES[final];
    if (!name) return;
    const countOnlyModifier = nums.length === 1 && nums[0] >= 2 && nums[0] <= 8;
    const mod = nums.length > 1 ? nums[nums.length - 1] : countOnlyModifier ? nums[0] : 1;
    const ctrl = !!(mod - 1 & 4), alt = !!(mod - 1 & 2), shift = !!(mod - 1 & 1);
    this.#emit({ type: "key", name, ctrl, alt, shift });
  }
  #kittyKey(params) {
    const [cpRaw = "0", modRaw = "1"] = params.split(";");
    const cp = Number(String(cpRaw).split(":")[0]) || 0;
    const m = (Number(String(modRaw).split(":")[0]) || 1) - 1;
    const ctrl = !!(m & 4), alt = !!(m & 2), shift = !!(m & 1);
    let name = KITTY_KEY_NAMES[cp];
    if (name === "tab" && shift) name = "backtab";
    if (name) {
      this.#emit({ type: "key", name, ctrl, alt, shift });
      return;
    }
    let text;
    try {
      text = String.fromCodePoint(cp);
    } catch {
      return;
    }
    if (ctrl && /^[a-zA-Z]$/.test(text)) text = text.toLowerCase();
    this.#emit({ type: "key", name: "char", key: text.toLowerCase(), text, ctrl, alt, shift });
  }
  #mouse(params, final) {
    const [b = 0, x = 0, y = 0] = params.split(";").filter((s) => s !== "").map(Number);
    const kind = final === "M" ? "press" : "release";
    const motion = !!(b & 32);
    const wheel = !!(b & 64);
    const button = b & 3;
    let ev;
    if (wheel) {
      ev = { type: "mouse", kind: button === 0 ? "wheel-up" : "wheel-down", button: button === 0 ? 4 : 5, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: false };
    } else if (motion) {
      ev = { type: "mouse", kind: button === 3 ? "release" : "drag", button: button === 3 ? 0 : button, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: true };
    } else {
      ev = { type: "mouse", kind, button, x: x - 1, y: y - 1, ctrl: !!(b & 16), shift: !!(b & 4), alt: !!(b & 8), motion: false };
    }
    this.#emit(ev);
  }
};

// vendor/dsh-neotui/src/text.js
function wcwidth(cp) {
  if (cp === 0) return 0;
  if (cp >= 768 && cp <= 879 || cp >= 6832 && cp <= 6911 || cp >= 7616 && cp <= 7679 || cp >= 8400 && cp <= 8447 || cp >= 65024 && cp <= 65039 || cp >= 65056 && cp <= 65071 || cp >= 8203 && cp <= 8207 || cp === 8288 || cp === 173) return 0;
  if (cp < 32 || cp >= 127 && cp < 160) return 0;
  if (cp >= 4352 && cp <= 4447 || cp === 9001 || cp === 9002 || cp >= 11904 && cp <= 42191 && cp !== 12351 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65040 && cp <= 65049 || cp >= 65072 && cp <= 65135 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 127744 && cp <= 129791 || cp >= 131072 && cp <= 262141) return 2;
  return 1;
}
var GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
function graphemes(s) {
  s = typeof s === "string" ? s : String(s ?? "");
  return GRAPHEME_SEGMENTER ? Array.from(GRAPHEME_SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
}
function graphemeWidth(g) {
  const cps = Array.from(g, (ch) => ch.codePointAt(0));
  const widths = cps.map(wcwidth);
  const clustered = cps.length > 1 && (g.includes("\u200D") || cps.some((cp) => cp >= 127995 && cp <= 127999) || cps.every((cp) => cp >= 127462 && cp <= 127487) || cps.includes(8419) || widths.some((width) => width === 0));
  return clustered ? Math.max(0, ...widths) : widths.reduce((a, b) => a + b, 0);
}
function strWidth(s) {
  let w = 0;
  for (const g of graphemes(s)) w += graphemeWidth(g);
  return w;
}
function truncate(s, w) {
  if (w <= 0) return "";
  const ell = "\u2026";
  if (strWidth(s) <= w) return s;
  let out = "", used = 0;
  for (const ch of graphemes(s)) {
    const cw = graphemeWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + ell;
}
function pad(s, w, align = "left") {
  const gap = w - strWidth(s);
  if (gap <= 0) return s;
  const sp = " ".repeat(gap);
  return align === "right" ? sp + s : s + sp;
}
function fmtDuration(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return "\u2014";
  const s = Math.floor(ms / 1e3);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (h > 0) return `${h}\u5C0F\u65F6${String(m).padStart(2, "0")}\u5206${String(sec).padStart(2, "0")}\u79D2`;
  if (m > 0) return `${m}\u5206${String(sec).padStart(2, "0")}\u79D2`;
  return `${sec}\u79D2`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function bars(values, width, { min = 0, max = 1 } = {}) {
  const out = [];
  for (let i = 0; i < width; i++) {
    const t = values[i] ?? 0;
    const span = max - min;
    const v = span === 0 ? t >= max ? 1 : 0 : Math.max(0, Math.min(1, (t - min) / span));
    let eighths = Math.round(v * 8);
    if (v > 0 && eighths <= 0) eighths = 1;
    if (eighths <= 0) out.push(" ");
    else if (eighths < 8) out.push(String.fromCodePoint(9601 + eighths - 1));
    else out.push("\u2588");
  }
  return out.join("");
}

// vendor/dsh-neotui/src/screen.js
var ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, REVERSE: 16, STRIKE: 32 };
var CELL_COUNTER = 0;
function blank() {
  CELL_COUNTER++;
  return { ch: " ", fg: -1, bg: -1, attrs: 0, wide: false, link: "" };
}
var Screen = class {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.prev = null;
    this.cells = [];
    this.resize(w, h);
  }
  resize(w, h) {
    w = Number.isFinite(w) ? Math.max(1, Math.floor(w)) : 80;
    h = Number.isFinite(h) ? Math.max(1, Math.floor(h)) : 24;
    this.w = w;
    this.h = h;
    this.cells = new Array(h);
    for (let y = 0; y < h; y++) {
      const row = new Array(w);
      for (let x = 0; x < w; x++) row[x] = blank();
      this.cells[y] = row;
    }
    this.prev = null;
  }
  clear(fg = -1, bg = -1) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const c = this.cells[y][x];
        c.ch = " ";
        c.fg = fg;
        c.bg = bg;
        c.attrs = 0;
        c.wide = false;
        c.link = "";
      }
  }
  /** Set one cell. Wide chars consume two columns; x+1 becomes a continuation. */
  put(x, y, ch = " ", { fg = -1, bg = -1, attrs = 0, link = "" } = {}) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    if (x > 0) {
      const left = this.cells[y][x - 1];
      if (left.wide) {
        left.ch = " ";
        left.wide = false;
        left.link = "";
      }
    }
    const cell = this.cells[y][x];
    if (cell.wide && x + 1 < this.w) {
      const oldCont = this.cells[y][x + 1];
      oldCont.ch = " ";
      oldCont.wide = false;
      oldCont.link = "";
    }
    const wide = graphemeWidth(ch) === 2;
    if (wide && x + 1 >= this.w) ch = " ";
    cell.ch = ch;
    cell.fg = fg;
    if (bg !== -1) cell.bg = bg;
    cell.attrs = attrs;
    cell.link = link;
    cell.wide = wide && x + 1 < this.w;
    if (cell.wide) {
      const cont = this.cells[y][x + 1];
      if (cont.wide && x + 2 < this.w) {
        const next = this.cells[y][x + 2];
        next.ch = " ";
        next.wide = false;
        next.link = "";
      }
      cont.ch = "";
      cont.fg = fg;
      cont.bg = cell.bg;
      cont.attrs = attrs;
      cont.link = link;
      cont.wide = false;
    }
  }
  /** Write text; wide-aware; clips at right edge. Returns final x. */
  text(x, y, s, style = {}) {
    let px = x;
    for (const ch of graphemes(s)) {
      const cw = graphemeWidth(ch);
      if (cw === 0) {
        if (px > 0 && y >= 0 && y < this.h) this.cells[y][px - 1].ch += ch;
        continue;
      }
      if (px >= this.w) break;
      if (cw === 2 && px + 1 >= this.w) break;
      this.put(px, y, ch, style);
      px += cw;
    }
    return px;
  }
  fillRect(x0, y0, x1, y1, ch = " ", style = {}) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.put(x, y, ch, style);
  }
  box(x0, y0, x1, y1, style = {}, title = "") {
    const { fg, bg = -1 } = style;
    const s = { fg, bg };
    for (let x = x0; x <= x1; x++) {
      this.put(x, y0, "\u2500", s);
      this.put(x, y1, "\u2500", s);
    }
    for (let y = y0; y <= y1; y++) {
      this.put(x0, y, "\u2502", s);
      this.put(x1, y, "\u2502", s);
    }
    this.put(x0, y0, "\u256D", s);
    this.put(x1, y0, "\u256E", s);
    this.put(x0, y1, "\u2570", s);
    this.put(x1, y1, "\u256F", s);
    if (title) this.text(x0 + 2, y0, " " + title + " ", s);
  }
  hline(x0, x1, y, ch = "\u2500", style = {}) {
    for (let x = x0; x <= x1; x++) this.put(x, y, ch, style);
  }
  /** Apply reverse-video over a rect (drag-selection highlight). */
  invertRect(x0, y0, x1, y1) {
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
        const c = this.cells[y][x];
        if (c.ch !== " " && c.ch !== "") c.attrs |= ATTR.REVERSE;
      }
  }
  vline(x, y0, y1, ch = "\u2502", style = {}) {
    for (let y = y0; y <= y1; y++) this.put(x, y, ch, style);
  }
  // ---- ANSI diff rendering ----
  sgr(fg, bg, attrs) {
    const parts = [];
    if (attrs !== 0) {
      const bold = attrs & ATTR.BOLD ? ";1" : "";
      const dim = attrs & ATTR.DIM ? ";2" : "";
      const ital = attrs & ATTR.ITALIC ? ";3" : "";
      const ul = attrs & ATTR.UNDERLINE ? ";4" : "";
      const rev = attrs & ATTR.REVERSE ? ";7" : "";
      const str = attrs & ATTR.STRIKE ? ";9" : "";
      parts.push(`\x1B[0${bold}${dim}${ital}${ul}${rev}${str}m`);
    }
    if (fg >= 0) parts.push(`\x1B[38;2;${fg >> 16 & 255};${fg >> 8 & 255};${fg & 255}m`);
    if (bg >= 0) parts.push(`\x1B[48;2;${bg >> 16 & 255};${bg >> 8 & 255};${bg & 255}m`);
    return parts.join("");
  }
  /** Render diff versus previous frame. Returns ANSI string (no final flush). */
  render() {
    const prev = this.prev;
    const out = [];
    let curFg = -1, curBg = -1, curAttrs = 0, curLink = "";
    const ensureStyle = (fg, bg, attrs) => {
      if (fg === curFg && bg === curBg && attrs === curAttrs) return;
      const needReset = bg === -1 && curBg !== -1 || fg === -1 && curFg !== -1 || attrs === 0 && curAttrs !== 0;
      curFg = fg;
      curBg = bg;
      curAttrs = attrs;
      if (fg === -1 && bg === -1 && attrs === 0) {
        out.push("\x1B[0m");
        return;
      }
      if (needReset) out.push("\x1B[0m");
      out.push(this.sgr(fg, bg, attrs));
    };
    const ensureLink = (link) => {
      if (link !== curLink) {
        if (curLink) out.push("\x1B]8;;\x1B\\");
        if (link) out.push(`\x1B]8;;${link}\x1B\\`);
        curLink = link;
      }
    };
    for (let y = 0; y < this.h; y++) {
      const row = this.cells[y];
      const prow = prev ? prev[y] : null;
      let x = 0;
      while (x < this.w) {
        const c = row[x];
        const p = prow ? prow[x] : null;
        let dirty = !p || p.ch !== c.ch || p.fg !== c.fg || p.bg !== c.bg || p.attrs !== c.attrs || p.link !== c.link || p.wide !== c.wide;
        if (!dirty && c.wide && prow && x + 1 < this.w) {
          const p2 = prow[x + 1];
          if (p2 && p2.ch !== "") dirty = true;
        }
        if (!dirty) {
          x++;
          continue;
        }
        out.push(`\x1B[${y + 1};${x + 1}H`);
        ensureStyle(c.fg, c.bg, c.attrs);
        ensureLink(c.link);
        out.push(c.ch === "" ? " " : c.ch);
        if (c.wide) x += 2;
        else x++;
      }
    }
    if (curLink) out.push("\x1B]8;;\x1B\\");
    out.push(`\x1B[${this.h};1H`);
    this.prev = this.cells;
    this.cells = new Array(this.h);
    for (let y = 0; y < this.h; y++) {
      const row = new Array(this.w);
      for (let x = 0; x < this.w; x++) row[x] = blank();
      this.cells[y] = row;
    }
    return out.join("");
  }
  /** Plain-text dump (no ANSI) for scripted tests. Reads the last rendered frame. */
  toPlain() {
    const cells = this.prev ?? this.cells;
    const lines = [];
    for (let y = 0; y < this.h; y++) {
      let s = "";
      const row = cells[y] ?? [];
      for (let x = 0; x < this.w; x++) {
        const c = row[x];
        s += c && c.ch !== "" ? c.ch : " ";
      }
      lines.push(s.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }
};

// vendor/dsh-neotui/src/api.js
var import_node_crypto = require("node:crypto");

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// vendor/dsh-neotui/src/auth.js
var AuthRequiredError = class extends Error {
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthRequiredError";
    this.code = "auth-required";
  }
};
var AuthSession = class {
  #token = null;
  #account = null;
  get authenticated() {
    return this.#token !== null;
  }
  get account() {
    return this.#account;
  }
  setLogin(result) {
    if (!result || typeof result.access_token !== "string" || result.access_token.length === 0) {
      throw new Error("login response is missing access_token");
    }
    if (result.token_type !== void 0 && String(result.token_type).toLowerCase() !== "bearer") {
      throw new Error(`unsupported token type: ${result.token_type}`);
    }
    this.#token = result.access_token;
    this.#account = result.account ?? null;
  }
  clear() {
    this.#token = null;
    this.#account = null;
  }
  authorization() {
    if (this.#token === null) throw new AuthRequiredError();
    return `Bearer ${this.#token}`;
  }
};

// vendor/dsh-neotui/src/cli.js
var DEFAULT_BASE = "https://139.155.78.241:8710/dsh";
var DEFAULT_WORKSPACE = "/home/ubuntu/workspaces/default";
var VALUE_OPTIONS = /* @__PURE__ */ new Map([
  ["--base", "base"],
  ["--workspace", "workspace"],
  ["--resume", "resume"],
  ["--cache", "cache"],
  ["--script", "script"]
]);
var FLAG_OPTIONS = /* @__PURE__ */ new Map([
  ["--check", "check"],
  ["--version", "version"],
  ["-v", "version"],
  ["--help", "help"],
  ["-h", "help"],
  ["--plain", "plain"]
]);
var CliUsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
};
function validateBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError(`--base must be an absolute HTTPS URL with the exact /dsh path: ${value}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/dsh" || url.search || url.hash) {
    throw new CliUsageError(`--base must be an absolute HTTPS URL with the exact /dsh path and no credentials, query, or fragment: ${value}`);
  }
  return url.href;
}
function validateWorkspace(value) {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new CliUsageError(`--workspace must be an absolute path on the remote Linux host: ${value}`);
  }
  return value;
}
function parseCli(argv, env = process.env) {
  const options = {
    base: env.DSH_URL || env.DSH_WEB_URL || DEFAULT_BASE,
    workspace: env.DSH_TUI_WORKSPACE || DEFAULT_WORKSPACE,
    resume: env.DSH_TUI_RESUME_SESSION || null,
    cache: env.DSH_TUI_CACHE_HOME || null,
    script: null,
    check: false,
    version: false,
    help: false,
    plain: false
  };
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (VALUE_OPTIONS.has(token)) {
      const key = VALUE_OPTIONS.get(token);
      if (seen.has(key)) throw new CliUsageError(`${token} may only be specified once`);
      const value = argv[++index];
      if (value === void 0 || value === "" || value.startsWith("-")) throw new CliUsageError(`${token} requires a value`);
      options[key] = value;
      seen.add(key);
      continue;
    }
    if (FLAG_OPTIONS.has(token)) {
      const key = FLAG_OPTIONS.get(token);
      if (seen.has(key)) throw new CliUsageError(`${token} may only be specified once`);
      options[key] = true;
      seen.add(key);
      continue;
    }
    if (token === "--attach") throw new CliUsageError("--attach is no longer supported; use --base");
    throw new CliUsageError(`unknown option: ${token}`);
  }
  options.base = validateBase(options.base);
  options.workspace = validateWorkspace(options.workspace);
  if (options.plain && !options.script) throw new CliUsageError("--plain requires --script");
  return options;
}
async function gatewayPreflight(base, { fetchImpl = fetch, timeoutMs = 1e4 } = {}) {
  const url = validateBase(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
  } catch (error) {
    const detail = error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error?.message ?? String(error);
    throw new Error(`gateway preflight could not reach ${url}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`gateway preflight refused redirect HTTP ${response.status} to ${response.headers?.get?.("location") ?? "an unknown location"}`);
  }
  if (response.status >= 500) throw new Error(`gateway preflight failed: gateway returned HTTP ${response.status}`);
  return {
    ok: true,
    base: url,
    status: response.status,
    reachable: true,
    authenticationRequired: response.status === 401 || response.status === 403
  };
}
function helpText(version) {
  return `DSH terminal client ${version}

Usage: dsh-client [options]

Options:
  --base <url>          HTTPS gateway URL with the exact /dsh path
  --workspace <path>    Absolute workspace path on the remote Linux host
  --resume <session-id> Resume a server session
  --cache <directory>   Override the local cache directory
  --check               Validate configuration and probe the gateway without login
  --version, -v         Print the client version
  --help, -h            Show this help
  --script <file>       Run the existing scripted test mode
  --plain               Print plain frames in scripted mode
`;
}

// vendor/dsh-neotui/src/api.js
var ApiError = class extends Error {
  constructor(error) {
    super(`${error?.code ?? "error"}: ${error?.message ?? JSON.stringify(error)}`);
    this.name = "ApiError";
    this.code = error?.code;
    this.details = error?.details;
    this.status = error?.status;
  }
};
var DEFAULT_BASE2 = "https://139.155.78.241:8710/dsh";
var Api = class {
  constructor({ base = DEFAULT_BASE2, auth = new AuthSession(), fetchImpl = fetch, WebSocketImpl = wrapper_default, log: log2 = () => {
  }, onFrame = () => {
  }, onHostFrame = () => {
  }, onStateChange = () => {
  }, onAuthRequired = () => {
  } } = {}) {
    this.base = validateBase(base);
    this.auth = auth;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log2;
    this.onFrame = onFrame;
    this.onHostFrame = onHostFrame;
    this.onStateChange = onStateChange;
    this.onAuthRequired = onAuthRequired;
    this.ws = null;
    this.hostWs = null;
    this.muxWs = null;
    this.closed = false;
    this.connected = false;
    this.connectionState = {
      mux: { ws: null, connected: false, retryDelay: 500, timer: null },
      host: { ws: null, connected: false, retryDelay: 500, timer: null }
    };
  }
  loginUrl() {
    const url = new URL(this.base);
    return `${url.protocol}//${url.host}/api/v1/auth/client-login`;
  }
  async login(email, password) {
    if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password === "") {
      throw new ApiError({ code: "invalid-credentials", message: "email and password are required" });
    }
    let res;
    try {
      res = await this.fetchImpl(this.loginUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), password })
      });
    } catch (error) {
      throw new ApiError({ code: "transport", message: `login unreachable: ${error.message}` });
    }
    if (!res.ok) {
      this.auth.clear();
      throw new ApiError({ code: "login-failed", message: `login HTTP ${res.status}`, status: res.status });
    }
    const body = await res.json();
    this.auth.setLogin(body);
    return { expires_at: body.expires_at, account: body.account };
  }
  #headers() {
    return { "content-type": "application/json", authorization: this.auth.authorization() };
  }
  #unauthorized(status) {
    if (status !== 401 && status !== 403) return false;
    this.auth.clear();
    this.closeStreams();
    this.onAuthRequired(status);
    return true;
  }
  async #post(path, body, label) {
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      throw new ApiError({ code: "transport", message: `${label} unreachable: ${error.message}` });
    }
    if (!res.ok) {
      this.#unauthorized(res.status);
      throw new ApiError({ code: res.status === 401 || res.status === 403 ? "auth-required" : "http", message: `${label} HTTP ${res.status}`, status: res.status });
    }
    return res;
  }
  async call(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload };
    const res = await this.#post(`/api/${method}`, env, method);
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }
  async logicalExport(sessionId, { pageSize = 80 } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ApiError({ code: "invalid-session", message: "sessionId is required" });
    }
    const events = [];
    let beforeSeq;
    let header = null;
    let projections = null;
    for (; ; ) {
      const page = await this.call("session.history", {
        sessionId,
        maxMessages: pageSize,
        ...beforeSeq === void 0 ? {} : { beforeSeq }
      });
      if (header === null && page.header !== void 0) header = page.header;
      if (projections === null && page.projections !== void 0) projections = page.projections;
      const batch = Array.isArray(page.events) ? page.events : [];
      events.unshift(...batch);
      if (!page.hasMore) break;
      const next = batch[0]?.event?.seq;
      if (!Number.isSafeInteger(next) || next < 0 || next === beforeSeq) {
        throw new ApiError({ code: "protocol", message: "session.history did not advance its cursor" });
      }
      beforeSeq = next;
    }
    const refs = /* @__PURE__ */ new Map();
    const visit = (value) => {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object") {
        if (typeof value.attachmentId === "string") refs.set(value.attachmentId, value);
        for (const item of Object.values(value)) visit(item);
      }
    };
    visit(events);
    const attachments = [];
    for (const [attachmentId] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
      const result = await this.call("session.attachment", { sessionId, attachmentId });
      const data = String(result.data ?? "");
      const bytes = Buffer.from(data, "base64");
      const sha256 = (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
      if (attachmentId.startsWith("sha256:") && attachmentId.slice(7) !== sha256) {
        throw new ApiError({ code: "attachment-hash", message: `attachment ${attachmentId} SHA-256 mismatch` });
      }
      attachments.push({ attachmentId, attachment: result.attachment ?? refs.get(attachmentId), bytes: bytes.length, sha256, data });
    }
    return { format: "dsh-logical-session-v1", sessionId, header, projections, events, attachments };
  }
  async respond(rpcId, value) {
    return this.#respondEnvelope(rpcId, { ok: true, value });
  }
  async cancelResponse(rpcId) {
    return this.#respondEnvelope(rpcId, { ok: false, error: { code: "cancelled", message: "cancelled by the TUI user" } });
  }
  async #respondEnvelope(rpcId, result) {
    const res = await this.#post("/api/respond", { type: "client-response", rpcId, result }, "respond");
    const receipt = await res.json();
    if (receipt?.accepted === false) throw new ApiError({ code: "response-rejected", message: receipt.reason ?? "response rejected" });
    return receipt;
  }
  connectMux() {
    this.#connect(this.wsUrl("events.mux"), "mux");
  }
  connectHost() {
    this.#connect(this.wsUrl("events.host"), "host");
  }
  wsUrl(path) {
    return `${this.base.replace(/^http/, "ws")}/api/${path}`;
  }
  #connect(url, kind) {
    if (this.closed || !this.auth.authenticated) return;
    const state = this.connectionState[kind];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    let ws;
    try {
      ws = new this.WebSocketImpl(url, { headers: { Authorization: this.auth.authorization() } });
    } catch (error) {
      if (error instanceof AuthRequiredError) this.onAuthRequired();
      else this.log(`[api] ${kind} stream failed: ${error.message}`);
      return;
    }
    state.ws = ws;
    if (kind === "mux") this.muxWs = ws;
    else this.hostWs = ws;
    this.ws = ws;
    ws.onopen = () => {
      if (state.ws !== ws || this.closed) return;
      state.connected = true;
      state.retryDelay = 500;
      this.log(`[api] ${kind} stream connected`);
      this.#publishConnectionState();
    };
    ws.onmessage = (message) => {
      if (state.ws !== ws || this.closed) return;
      let body;
      try {
        body = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (body?.type !== "server-request") return;
      const frame = body.payload ?? {};
      frame.__rpcId = body.rpcId;
      if (kind === "mux") this.onFrame(frame);
      else this.onHostFrame(frame);
    };
    ws.on?.("unexpected-response", (_request, response) => {
      if (this.#unauthorized(response.statusCode)) try {
        ws.terminate();
      } catch {
      }
    });
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.connected = false;
      state.ws = null;
      this.#publishConnectionState();
      if (this.closed || !this.auth.authenticated) return;
      const delay = state.retryDelay;
      this.log(`[api] ${kind} stream closed, reconnecting in ${delay}ms`);
      state.timer = setTimeout(() => {
        state.timer = null;
        this.#connect(url, kind);
      }, delay);
      state.retryDelay = Math.min(Math.max(500, delay * 2), 15e3);
    };
    ws.onerror = () => {
    };
  }
  #publishConnectionState() {
    const mux = this.connectionState.mux.connected;
    const host = this.connectionState.host.connected;
    this.connected = mux;
    this.onStateChange(mux && host ? "connected" : mux || host ? "degraded" : "disconnected");
  }
  async rpcCall(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args: payload ?? {} } };
    const res = await this.#post(`/api/${method}`, env, "rpc");
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad rpc envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }
  refreshMux() {
    if (this.closed || !this.auth.authenticated) return;
    const state = this.connectionState.mux;
    state.retryDelay = 0;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.ws) try {
      state.ws.close();
    } catch {
    }
    else this.#connect(this.wsUrl("events.mux"), "mux");
  }
  get muxConnected() {
    return this.connectionState.mux.connected;
  }
  get hostConnected() {
    return this.connectionState.host.connected;
  }
  closeStreams() {
    for (const state of Object.values(this.connectionState)) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.connected = false;
      try {
        state.ws?.close();
      } catch {
      }
      state.ws = null;
    }
    this.connected = false;
    this.#publishConnectionState();
  }
  close() {
    this.closed = true;
    this.closeStreams();
    this.auth.clear();
  }
};

// vendor/dsh-neotui/src/theme.js
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// vendor/dsh-neotui/src/platform.js
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_node_child_process = require("node:child_process");
function configRoot(env = process.env, platform = process.platform) {
  if (env.DSH_HOME) return env.DSH_HOME;
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error("APPDATA is required for DSH TUI configuration");
    return (0, import_node_path.join)(env.APPDATA, "DshTui");
  }
  return env.XDG_CONFIG_HOME ? (0, import_node_path.join)(env.XDG_CONFIG_HOME, "dsh-tui") : (0, import_node_path.join)(env.HOME ?? ".", ".config", "dsh-tui");
}
function stateRoot(env = process.env, platform = process.platform) {
  if (env.DSH_HOME) return env.DSH_HOME;
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for DSH TUI state");
    return (0, import_node_path.join)(env.LOCALAPPDATA, "DshTui");
  }
  return env.XDG_STATE_HOME ? (0, import_node_path.join)(env.XDG_STATE_HOME, "dsh-tui") : (0, import_node_path.join)(env.HOME ?? ".", ".local", "state", "dsh-tui");
}
function openExternal(path, { platform = process.platform, run = import_node_child_process.spawn } = {}) {
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  const child = run(command, [path], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return child;
}
function restartProcess(argv, env, { platform = process.platform, execPath = process.execPath, run = import_node_child_process.spawn } = {}) {
  const command = platform === "win32" ? execPath : "sh";
  const args = platform === "win32" ? argv : ["-c", 'sleep 1; exec "$@"', "sh", ...argv];
  const child = run(command, args, { detached: true, stdio: "inherit", env, windowsHide: false });
  child.unref?.();
  return child;
}
function editorCommand(editor, platform = process.platform) {
  const configured = String(editor ?? "").trim();
  if (configured) {
    const match = configured.match(/^(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/);
    if (!match) throw new Error(`invalid editor command: ${configured}`);
    return { command: match[1] || match[2], args: match[3]?.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [] };
  }
  return platform === "win32" ? { command: "notepad.exe", args: [] } : { command: "vi", args: [] };
}
function runEditor(file, editor, { platform = process.platform, run = import_node_child_process.spawnSync } = {}) {
  const { command, args } = editorCommand(editor, platform);
  const result = run(command, [...args, file], { stdio: "inherit", windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}
function copyImageFromClipboard({ platform = process.platform, runSync = import_node_child_process.spawnSync } = {}) {
  if (platform === "win32") {
    const file = (0, import_node_path.join)((0, import_node_os.tmpdir)(), `dsh-tui-paste-${process.pid}-${Date.now()}.png`);
    const escaped = file.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }; $image=[System.Windows.Forms.Clipboard]::GetImage(); try { $image.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }`;
    const result = runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: "ignore", windowsHide: true });
    if (result.status === 3) return null;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PowerShell clipboard helper exited with code ${result.status}`);
    try {
      return (0, import_node_fs.readFileSync)(file);
    } finally {
      try {
        (0, import_node_fs.unlinkSync)(file);
      } catch {
      }
    }
  }
  if (platform === "darwin") return null;
  const types = runSync("wl-paste", ["--list-types"], { encoding: "utf8" });
  if (types.status !== 0) return null;
  const mediaType = String(types.stdout ?? "").split(/\r?\n/).find((type) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type));
  if (!mediaType) return null;
  const image = runSync("wl-paste", ["--no-newline", "--type", mediaType], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  return image.status === 0 && image.stdout?.length ? image.stdout : null;
}
function detectImageType(data, advertised = "image/png") {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
  if (data[0] === 255 && data[1] === 216) return "image/jpeg";
  if (data.slice(0, 4).toString() === "RIFF" && data.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (data.slice(0, 3).toString() === "GIF") return "image/gif";
  return advertised;
}
function copyImageToClipboard(data, mediaType, { platform = process.platform, run = import_node_child_process.spawn, runSync = import_node_child_process.spawnSync } = {}) {
  if (platform === "win32") {
    if (mediaType !== "image/png") throw new Error("Windows image clipboard currently requires PNG data");
    const file = (0, import_node_path.join)((0, import_node_os.tmpdir)(), `dsh-tui-clipboard-${process.pid}-${Date.now()}.png`);
    (0, import_node_fs.writeFileSync)(file, data);
    const escaped = file.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image=[System.Drawing.Image]::FromFile('${escaped}'); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }`;
    const result = runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: "ignore", windowsHide: true });
    try {
      (0, import_node_fs.unlinkSync)(file);
    } catch {
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PowerShell clipboard helper exited with code ${result.status}`);
    return;
  }
  if (platform === "darwin") throw new Error("image clipboard is not supported on macOS by this client");
  const child = run("wl-copy", ["--type", mediaType], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.on?.("error", () => {
  });
  child.stdin.end(data);
}

// vendor/dsh-neotui/src/theme.js
var THEMES = {
  dark: {
    name: "dark",
    BG: 1185050,
    BG2: 1448480,
    PANEL: 1843496,
    STATUSBG: 2040875,
    CARD: 1580324,
    USERBG: 2237998,
    THINKBG: 1579808,
    TOOLBG: 1973806,
    TOOLOK: 1977886,
    TOOLERR: 3022366,
    BORDER: 2765372,
    BORDER2: 3818060,
    TXT: 13949149,
    DIM: 9147294,
    FAINT: 6055536,
    BOLD: 16777215,
    ACCENT: 6797311,
    ACCENT2: 5087231,
    HEADING: 8177663,
    LINK: 6797311,
    CODE: 10282477,
    CODEBG: 1843496,
    OK: 8248966,
    WARN: 16107883,
    ERR: 16743034,
    PURPLE: 10454783,
    RED: 16747146,
    GREEN: 9101205,
    PINK: 16757683,
    GREENG: 11790008,
    KEYWORD: 13079274,
    STRING: 10011513,
    NUMBER: 13736550,
    TABLEHEAD: 15922422,
    TABLESEP: 3818060,
    QUOTE: 9147550,
    QUOTEFG: 13094097,
    SELBG: 3820124,
    SELFG: 16777215,
    CURSORBG: 3820124,
    CURSORFG: 16777215,
    MENUBG: 1843496,
    MENUSEL: 3820124,
    SCROLLTHUMB: 6797311,
    SCROLLTRACK: 2765372
  },
  light: {
    name: "light",
    BG: 16185078,
    BG2: 15790320,
    PANEL: 16777215,
    STATUSBG: 15263976,
    CARD: 16777215,
    USERBG: 15527148,
    THINKBG: 15921906,
    TOOLBG: 15330807,
    TOOLOK: 15332585,
    TOOLERR: 16247273,
    BORDER: 13948116,
    BORDER2: 12632256,
    TXT: 2763306,
    DIM: 6710886,
    FAINT: 10066329,
    BOLD: 0,
    ACCENT: 679895,
    ACCENT2: 679895,
    HEADING: 679895,
    LINK: 679895,
    CODE: 10103662,
    CODEBG: 15790320,
    OK: 2067005,
    WARN: 11037184,
    ERR: 13640226,
    PURPLE: 6963152,
    RED: 13640226,
    GREEN: 2067005,
    PINK: 12603488,
    GREENG: 2787914,
    KEYWORD: 8138688,
    STRING: 2060093,
    NUMBER: 10508800,
    TABLEHEAD: 1118481,
    TABLESEP: 12632256,
    QUOTE: 7829367,
    QUOTEFG: 4473924,
    SELBG: 13624575,
    SELFG: 0,
    CURSORBG: 13624575,
    CURSORFG: 0,
    MENUBG: 16777215,
    MENUSEL: 13624575,
    SCROLLTHUMB: 679895,
    SCROLLTRACK: 13948116
  },
  gruvbox: {
    name: "gruvbox",
    BG: 2631720,
    BG2: 2368548,
    PANEL: 3289135,
    STATUSBG: 3289135,
    CARD: 3289135,
    USERBG: 3946550,
    THINKBG: 3025704,
    TOOLBG: 3095100,
    TOOLOK: 3357747,
    TOOLERR: 3945010,
    BORDER: 5261637,
    BORDER2: 6708308,
    TXT: 15457202,
    DIM: 11049348,
    FAINT: 8154980,
    BOLD: 16511431,
    ACCENT: 8627608,
    ACCENT2: 9355388,
    HEADING: 9355388,
    LINK: 8627608,
    CODE: 9355388,
    CODEBG: 3946550,
    OK: 12106534,
    WARN: 16432431,
    ERR: 16468276,
    PURPLE: 13862555,
    RED: 16468276,
    GREEN: 12106534,
    PINK: 13862555,
    GREENG: 12106534,
    KEYWORD: 13862555,
    STRING: 12106534,
    NUMBER: 14048526,
    TABLEHEAD: 16511431,
    TABLESEP: 6708308,
    QUOTE: 11049348,
    QUOTEFG: 15457202,
    SELBG: 5261637,
    SELFG: 16511431,
    CURSORBG: 6708308,
    CURSORFG: 16511431,
    MENUBG: 3289135,
    MENUSEL: 5261637,
    SCROLLTHUMB: 8627608,
    SCROLLTRACK: 5261637
  }
};
function themeFile() {
  return (0, import_node_path2.join)(configRoot(), "tui-theme.txt");
}
var current = "gruvbox";
var ORDER = ["dark", "light", "gruvbox"];
try {
  const saved = (0, import_node_fs2.readFileSync)(themeFile(), "utf8").trim();
  if (THEMES[saved]) current = saved;
} catch {
}
var T = new Proxy({}, {
  get(_t, key) {
    return THEMES[current][key];
  }
});
function persist() {
  try {
    (0, import_node_fs2.mkdirSync)((0, import_node_path2.dirname)(themeFile()), { recursive: true });
    (0, import_node_fs2.writeFileSync)(themeFile(), current + "\n");
  } catch {
  }
}
function cycleTheme() {
  current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  persist();
  return current;
}
function themeName() {
  return current;
}

// vendor/dsh-neotui/src/md.js
var C = new Proxy({}, {
  get(_c, key) {
    const map = {
      text: "TXT",
      dim: "DIM",
      faint: "FAINT",
      heading: "HEADING",
      bold: "BOLD",
      code: "CODE",
      codeBg: "CODEBG",
      link: "LINK",
      blockquote: "QUOTE",
      blockquoteFg: "QUOTEFG",
      tableHead: "TABLEHEAD",
      tableSep: "TABLESEP",
      listMarker: "ACCENT",
      hr: "BORDER2",
      img: "PURPLE",
      keyword: "KEYWORD",
      string: "STRING",
      number: "NUMBER"
    };
    return T[map[key] ?? key];
  }
});
var SEG = (t, extra = {}) => ({ t, ...extra });
function parseInline(text, base = {}) {
  const segs = [];
  const push = (t, extra = {}) => {
    if (!t) return;
    segs.push(SEG(t, { ...base, ...extra }));
  };
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      push(plain);
      plain = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j++;
      if (j < text.length) {
        flush();
        push(text.slice(i + 1, j), { code: true, fg: C.code });
        i = j + 1;
        continue;
      }
    } else if (ch === "*") {
      if (text[i + 1] === "*") {
        let j = text.indexOf("**", i + 2);
        if (j > i) {
          flush();
          push(text.slice(i + 2, j), { bold: true, fg: C.bold });
          i = j + 2;
          continue;
        }
      } else {
        let j = text.indexOf("*", i + 1);
        if (j > i) {
          flush();
          push(text.slice(i + 1, j), { italic: true });
          i = j + 1;
          continue;
        }
      }
    } else if (ch === "_" && text[i + 1] === "_") {
      let j = text.indexOf("__", i + 2);
      if (j > i) {
        flush();
        push(text.slice(i + 2, j), { bold: true, fg: C.bold });
        i = j + 2;
        continue;
      }
    } else if (ch === "~" && text[i + 1] === "~") {
      let j = text.indexOf("~~", i + 2);
      if (j > i) {
        flush();
        push(text.slice(i + 2, j), { strike: true, fg: C.dim });
        i = j + 2;
        continue;
      }
    } else if (ch === "!") {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        push(`\u25A3 ${m[1] || "image"}`, { fg: C.img, link: m[2] });
        i += m[0].length;
        continue;
      }
    } else if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        push(m[1], { fg: C.link, link: m[2] });
        i += m[0].length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return segs;
}
var HL = {
  js: [/\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|new|class|extends|try|catch|finally|throw|typeof|of|in|do|switch|case|break|default)\b/g, C.keyword],
  ts: [/\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|new|class|extends|try|catch|finally|throw|typeof|of|in|interface|type|enum|implements|public|private|readonly)\b/g, C.keyword],
  py: [/\b(def|return|if|elif|else|for|while|import|from|class|try|except|finally|with|as|lambda|yield|raise|pass|break|continue|async|await|None|True|False|self)\b/g, C.keyword],
  sh: [/(^|\s)(cd|ls|cat|grep|sed|awk|node|npm|pnpm|git|curl|find|echo|export|mkdir|rm|mv|cp|chmod|sudo|docker|systemctl|python|pip|bash|zsh|tmux|ssh|scp|rsync|head|tail|sort|uniq|wc|diff|make|tar|zip|unzip)(?=\s|$)/g, C.keyword],
  bash: [/(^|\s)(cd|ls|cat|grep|sed|awk|node|npm|pnpm|git|curl|find|echo|export|mkdir|rm|mv|cp|chmod|sudo|docker|systemctl|python|pip|bash|zsh|tmux|ssh|scp|rsync|head|tail|sort|uniq|wc|diff|make|tar|zip|unzip)(?=\s|$)/g, C.keyword],
  json: [/"(\\"|[^"])*"(?=\s*:)/g, C.link],
  yaml: [/^(\s*)([A-Za-z0-9_.-]+)(:)/g, C.link],
  md: [/(^|\s)(#{1,6}\s[^\n]*)/g, C.link],
  sql: [/\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|BY|ORDER|LIMIT|AND|OR|NOT|NULL|AS|COUNT|SUM|AVG)\b/g, C.keyword]
};
var HL_STRINGS = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
var HL_COMMENTS = /\/\/[^\n]*|#[^\n]*|--[^\n]*/g;
var HL_NUMBERS = /\b\d+(\.\d+)?\b/g;
function highlightLine(line, lang) {
  const segs = [{ t: line, fg: C.text }];
  const rules = HL[lang] ? [HL[lang]] : [];
  for (const [re, color] of rules) {
    const out = [];
    for (const seg of segs) {
      if (seg.fg !== C.text || seg.code) {
        out.push(seg);
        continue;
      }
      let last = 0;
      re.lastIndex = 0;
      for (let m; (m = re.exec(seg.t)) !== null; ) {
        if (m.index > last) out.push(SEG(seg.t.slice(last, m.index), { fg: C.text }));
        out.push(SEG(m[0], { fg: color, bold: true }));
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (last < seg.t.length) out.push(SEG(seg.t.slice(last), { fg: C.text }));
    }
    segs.splice(0, segs.length, ...out);
  }
  const apply = (re, color, style = {}) => {
    const out = [];
    for (const seg of segs) {
      if (seg.fg !== C.text || seg.code) {
        out.push(seg);
        continue;
      }
      let last = 0;
      re.lastIndex = 0;
      for (let m; (m = re.exec(seg.t)) !== null; ) {
        if (m.index > last) out.push(SEG(seg.t.slice(last, m.index), { fg: C.text }));
        out.push(SEG(m[0], { fg: color, ...style }));
        last = m.index + m[0].length;
      }
      if (last < seg.t.length) out.push(SEG(seg.t.slice(last), { fg: C.text }));
    }
    segs.splice(0, segs.length, ...out);
  };
  apply(HL_STRINGS, C.string);
  apply(HL_COMMENTS, C.faint, { italic: true });
  apply(HL_NUMBERS, C.number);
  return segs;
}
function renderMd(text, width, sink = null, opts = {}) {
  if (typeof text !== "string") text = String(text ?? "");
  const hardBreaks = !!opts.hardBreaks;
  const lines = [];
  const pushLine = (segs = []) => {
    if (segs.length === 0) segs = [SEG(" ")];
    lines.push(segs);
  };
  const src = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let inCode = null;
  let codeBuf = [];
  let para = [];
  let quote = [];
  let listBuf = [];
  let tableBuf = [];
  const flushPara = () => {
    if (para.length === 0) return;
    if (hardBreaks) {
      for (const line of para) {
        lines.push(...wrapSegs(parseInline(line), width));
      }
    } else {
      const segs = parseInline(para.join(" "));
      lines.push(...wrapSegs(segs, width));
    }
    para = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    const segs = parseInline(quote.join(" "));
    const wrapped = wrapSegs(segs, width - 3);
    for (const ln of wrapped) lines.push([SEG("\u258E", { fg: C.blockquote, bold: true }), SEG(" "), ...ln]);
    quote = [];
  };
  const flushList = () => {
    if (listBuf.length === 0) return;
    for (const item of listBuf) {
      const segs = parseInline(item);
      const wrapped = wrapSegs(segs, width - 3);
      wrapped[0] = [SEG("\u2022", { fg: C.listMarker, bold: true }), SEG(" "), ...wrapped[0]];
      for (let k = 1; k < wrapped.length; k++) wrapped[k] = [SEG("  "), ...wrapped[k]];
      lines.push(...wrapped);
    }
    listBuf = [];
  };
  const flushTable = () => {
    if (tableBuf.length < 2) {
      tableBuf = [];
      return;
    }
    const rows = tableBuf.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    if (rows.length === 0) {
      tableBuf = [];
      return;
    }
    const split = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const header = split(rows[0]);
    const body = rows.slice(1).map(split);
    const n = Math.max(header.length, ...body.map((r) => r.length));
    const maxw = [];
    for (let c = 0; c < n; c++) {
      let m = strWidth(header[c] ?? "");
      for (const r of body) m = Math.max(m, strWidth(r[c] ?? ""));
      maxw[c] = Math.min(m, Math.max(6, Math.floor(width / n) - 2));
    }
    const renderRow = (cells, headerRow) => {
      const segs = [];
      cells.forEach((cell, c) => {
        const cellText = truncate(cell ?? "", maxw[c]);
        const parts = headerRow ? parseInline(cellText, { bold: true, fg: C.tableHead }) : parseInline(cellText);
        segs.push(...parts);
        if (c < n - 1) segs.push(SEG(" \u2502 ", { fg: C.tableSep }));
      });
      lines.push(segs);
    };
    renderRow(header, true);
    lines.push([SEG(header.map((_, c) => "\u2500".repeat(maxw[c]) + (c < n - 1 ? "\u2500\u253C\u2500" : "")).join(""), { fg: C.tableSep })]);
    for (const r of body) renderRow(r, false);
    tableBuf = [];
  };
  while (i < src.length) {
    const line = src[i];
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      flushPara();
      flushQuote();
      flushList();
      flushTable();
      if (inCode === null) {
        inCode = fence[1] || "";
        codeBuf = [];
      } else {
        const lang = inCode || "text";
        const hw = Math.max(2, width - 4);
        const codeLines = codeBuf.length === 0 ? [""] : codeBuf;
        const codeMeta = { text: codeBuf.join("\n"), lineIdx: lines.length, lang };
        if (sink?.codeBlocks) sink.codeBlocks.push(codeMeta);
        const btn = "[\u590D\u5236]";
        const activeBtn = "[\u6309y\u590D\u5236]";
        const btnW = strWidth(btn);
        const tagPart = lang && lang !== "text" ? lang + " " : "";
        const tagW = strWidth(tagPart);
        const reserveW = Math.max(btnW, Math.min(strWidth(activeBtn), Math.max(0, hw - tagW)));
        const btnField = btn + " ".repeat(Math.max(0, reserveW - btnW));
        const tailPad = Math.max(1, hw + 1 - tagW - reserveW);
        const inner = hw + 2;
        lines.push([
          SEG("\u250C\u2500" + tagPart, { fg: C.hr, codeBlock: codeMeta }),
          SEG(btnField, { fg: C.link, bold: true, copyCode: codeBuf.join("\n"), codeBlock: codeMeta }),
          SEG("\u2500".repeat(tailPad) + "\u2510", { fg: C.hr, codeBlock: codeMeta })
        ]);
        for (const cl of codeLines) {
          const hls = highlightLine(cl, lang);
          for (const row of wrapSegs(hls, hw)) {
            const rowW = strWidth(row.map((g) => g.t ?? "").join(""));
            const segs = [SEG("\u2502 ", { fg: C.hr, codeBlock: codeMeta }), ...row.map((seg) => ({ ...seg, codeBlock: codeMeta }))];
            if (rowW < hw) segs.push(SEG(" ".repeat(hw - rowW)));
            segs.push(SEG(" \u2502", { fg: C.hr, codeBlock: codeMeta }));
            lines.push(segs);
          }
        }
        lines.push([SEG("\u2514" + "\u2500".repeat(inner) + "\u2518", { fg: C.hr, codeBlock: codeMeta })]);
        inCode = null;
      }
      i++;
      continue;
    }
    if (inCode !== null) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushQuote();
      flushList();
      flushTable();
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushQuote();
      flushList();
      flushTable();
      const level = heading[1].length;
      const prefix = "#".repeat(level) + " ";
      const segs = parseInline(heading[2], { bold: true, fg: C.heading });
      lines.push([SEG(prefix, { fg: C.listMarker, bold: true }), ...wrapSegs(segs, width - level - 1).flatMap((l, k) => k === 0 ? l : [SEG("  ".repeat(level), { fg: C.faint }), ...l])]);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara();
      flushQuote();
      flushList();
      flushTable();
      lines.push([SEG("\u2500".repeat(Math.min(width, 40)), { fg: C.hr })]);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      flushList();
      flushTable();
      quote.push(line.replace(/^\s*>\s?/, ""));
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      flushQuote();
      flushTable();
      listBuf.push(line.replace(/^\s*[-*+]\s+/, ""));
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      flushQuote();
      flushTable();
      listBuf.push(line.replace(/^\s*\d+[.)]\s+/, ""));
      i++;
      continue;
    }
    if (line.includes("|")) {
      flushPara();
      flushQuote();
      flushList();
      tableBuf.push(line);
      i++;
      continue;
    }
    flushQuote();
    flushList();
    flushTable();
    para.push(line.trim());
    i++;
  }
  flushPara();
  flushQuote();
  flushList();
  flushTable();
  if (inCode !== null && codeBuf.length) {
    const hw = Math.max(2, width - 4);
    for (const cl of codeBuf) lines.push([SEG("\u2502 ", { fg: C.hr }), ...wrapSegs(highlightLine(cl, inCode || "text"), hw), SEG(" \u2502", { fg: C.hr })]);
  }
  return lines;
}
function wrapSegs(segs, width, { pad: padLines = false } = {}) {
  if (width < 2) width = 2;
  const flat = [];
  for (const seg of segs) {
    for (const word of seg.t.split(/(\s+)/)) {
      if (!word) continue;
      flat.push({ ...seg, t: word });
    }
  }
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const seg of flat) {
    let w = strWidth(seg.t);
    if (w > width) {
      let rest = seg.t;
      while (strWidth(rest) > width) {
        let cut = "";
        let cw = 0;
        for (const ch of graphemes(rest)) {
          const cwc = strWidth(ch);
          if (cw + cwc > width) break;
          cut += ch;
          cw += cwc;
        }
        if (!cut) cut = graphemes(rest)[0] ?? "";
        if (curW > 0) {
          lines.push(cur);
          cur = [];
          curW = 0;
        }
        lines.push([{ ...seg, t: cut }]);
        rest = rest.slice(cut.length);
      }
      if (rest) {
        cur.push({ ...seg, t: rest });
        curW = strWidth(rest);
      }
      continue;
    }
    if (curW > 0 && curW + w > width) {
      lines.push(cur);
      cur = [];
      curW = 0;
    }
    if (curW === 0 && /^\s+$/.test(seg.t)) continue;
    cur.push(seg);
    curW += w;
  }
  if (cur.length) lines.push(cur);
  if (lines.length === 0) lines.push([SEG("")]);
  return lines;
}

// vendor/dsh-neotui/src/views.js
var import_node_fs7 = require("node:fs");
var import_node_path7 = require("node:path");
var import_node_child_process4 = require("node:child_process");
var import_node_module = require("node:module");

// vendor/dsh-neotui/src/cache.js
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var import_node_sqlite = require("node:sqlite");
var ALLOWED_STORES = /* @__PURE__ */ new Set([
  "projections",
  "revisions",
  "root_mappings",
  "local_fts",
  "code_indexes",
  "cursor",
  "outbox",
  "conflicts"
]);
function cacheRoot(env = process.env, platform = process.platform) {
  if (env.DSH_TUI_CACHE_HOME) return env.DSH_TUI_CACHE_HOME;
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for the NeoTUI cache");
    return (0, import_node_path3.join)(env.LOCALAPPDATA, "DshTui");
  }
  const base = env.XDG_CACHE_HOME ?? (0, import_node_path3.join)(env.HOME ?? ".", ".cache");
  return (0, import_node_path3.join)(base, "dsh-tui");
}
function cacheFile() {
  return (0, import_node_path3.join)(cacheRoot(), "cache.db");
}
function storeName(store) {
  if (!ALLOWED_STORES.has(store)) throw new Error(`cache store is not allowed: ${store}`);
  return store;
}
var CacheRepository = class _CacheRepository {
  constructor(path = cacheFile()) {
    this.path = path;
    (0, import_node_fs3.mkdirSync)((0, import_node_path3.dirname)(path), { recursive: true });
    this.db = new import_node_sqlite.DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache_entries (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store, key)
      );
    `);
  }
  put(store, key, value) {
    store = storeName(store);
    if (/(token|password|credential|secret)/i.test(String(key))) throw new Error("credentials are forbidden in cache.db");
    const json = JSON.stringify(value);
    if (/(access_token|refresh_token|password|authorization)/i.test(json)) throw new Error("credentials are forbidden in cache.db");
    this.db.prepare(`
      INSERT INTO cache_entries(store, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(store, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(store, String(key), json, Date.now());
  }
  get(store, key) {
    store = storeName(store);
    const row = this.db.prepare("SELECT value_json FROM cache_entries WHERE store = ? AND key = ?").get(store, String(key));
    return row ? JSON.parse(row.value_json) : null;
  }
  delete(store, key) {
    store = storeName(store);
    this.db.prepare("DELETE FROM cache_entries WHERE store = ? AND key = ?").run(store, String(key));
  }
  clear() {
    this.db.exec("DELETE FROM cache_entries");
  }
  close() {
    this.db.close();
  }
  static rebuild(path = cacheFile()) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) (0, import_node_fs3.rmSync)(file, { force: true });
    return new _CacheRepository(path);
  }
};

// vendor/dsh-neotui/src/widgets.js
function wrapIndex(index, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return (index % length + length) % length;
}
var Widget = class {
  constructor({ x = 0, y = 0, w = 0, h = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.visible = true;
  }
  inside(px, py) {
    return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  }
  hitTest(px, py) {
    return this.inside(px, py) ? this : null;
  }
  render() {
  }
  onMouse() {
    return false;
  }
  onKey() {
    return false;
  }
  onFocus() {
  }
  onBlur() {
  }
  dispose() {
  }
};
var ScrollView = class extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.lines = [];
    this.scrollY = 0;
    this.anchorLock = null;
    this.follow = opts.follow ?? true;
    this.autoScroll = opts.autoScroll ?? false;
    this.onClick = opts.onClick ?? null;
    this.onWheel = null;
    this.showScrollbar = opts.showScrollbar ?? true;
    this.title = opts.title ?? "";
  }
  setLines(lines, { keep = false } = {}) {
    const atBottom = this.autoScroll && this.follow && this.scrollY + this.h >= this.lines.length - 1 || keep && this.scrollY + this.h >= this.lines.length;
    this.lines = lines;
    if (this.anchorLock != null) {
      this.scrollY = this.anchorLock;
      if (this.scrollY <= Math.max(0, this.lines.length - this.h)) this.anchorLock = null;
    } else if (atBottom || this.scrollY > Math.max(0, this.lines.length - this.h)) {
      this.scrollY = Math.max(0, this.lines.length - this.h);
    }
  }
  contentHeight() {
    return Math.max(this.lines.length, 0);
  }
  maxScroll() {
    return Math.max(0, this.lines.length - this.h);
  }
  scroll(dy) {
    const before = this.scrollY;
    this.anchorLock = null;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy));
    this.follow = this.scrollY >= this.maxScroll();
    return this.scrollY !== before;
  }
  render(screen) {
    if (!this.visible) return;
    const y0 = this.y;
    for (let i = 0; i < this.h; i++) {
      const lineIdx = this.scrollY + i;
      const line = this.lines[lineIdx];
      if (!line) {
        screen.hline(this.x, this.x + this.w - 1, y0 + i, " ", {});
        continue;
      }
      let px = this.x;
      for (const seg of line) {
        const w = strWidth(seg.t);
        if (w === 0) continue;
        if (px >= this.x + this.w) break;
        const style = {
          fg: seg.fg,
          bg: seg.bg,
          attrs: (seg.bold ? 1 : 0) | (seg.dim ? 2 : 0) | (seg.italic ? 4 : 0) | (seg.underline ? 8 : 0) | (seg.strike ? 32 : 0) | (seg.reverse ? 16 : 0),
          link: seg.link
        };
        let tx = seg.t;
        if (px + w > this.x + this.w) tx = truncate(tx, this.x + this.w - px);
        screen.text(px, y0 + i, tx, style);
        px += strWidth(tx);
      }
    }
    if (this.showScrollbar && this.lines.length > this.h) {
      const sbX = this.x + this.w - 1;
      const trackH = Math.max(1, this.h - 2);
      const total = Math.max(1, this.lines.length);
      const thumbH = Math.max(1, Math.floor(this.h * this.h / total));
      const frac = Math.min(1, this.scrollY / Math.max(1, this.maxScroll()));
      const thumbY = Math.floor((this.h - 2) * frac);
      for (let i = 0; i < this.h; i++) {
        const inThumb = i >= 1 + thumbY && i < 1 + thumbY + thumbH;
        const inTrack = i >= 1 && i < this.h - 1;
        screen.put(sbX, y0 + i, inThumb ? "\u2588" : inTrack ? "\u2591" : " ", { fg: inThumb ? T.SCROLLTHUMB : T.SCROLLTRACK });
      }
    }
    if (this.title) screen.text(this.x, y0, this.title, { fg: T.DIM, attrs: 8 });
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") return this.scroll(-3);
    if (ev.kind === "wheel-down") return this.scroll(3);
    if (this.showScrollbar && this.lines.length > this.h && ev.x === this.x + this.w - 1) {
      if (ev.kind === "press" && ev.button === 0) {
        this.scrubbing = true;
        this.#scrubTo(ev.y);
        return true;
      }
      if (ev.kind === "drag" && ev.button === 0 && this.scrubbing) {
        this.#scrubTo(ev.y);
        return true;
      }
      if (ev.kind === "release" && ev.button === 0 && this.scrubbing) {
        this.scrubbing = false;
        return true;
      }
      return this.scrubbing;
    }
    if (ev.kind === "press" && ev.button === 0) {
      if (this.onClick && this.onClick(ev.y - this.y + this.scrollY, ev)) return true;
      return false;
    }
    return false;
  }
  #scrubTo(ey) {
    this.anchorLock = null;
    this.follow = this.scrollY >= this.maxScroll();
    const trackH = Math.max(1, this.h - 2);
    const total = Math.max(1, this.lines.length);
    const thumbH = Math.max(1, Math.floor(this.h * this.h / total));
    const ty = Math.max(0, Math.min(this.h - 2 - thumbH, ey - this.y - 1 - Math.floor(thumbH / 2)));
    const frac = this.h - 2 - thumbH > 0 ? ty / (this.h - 2 - thumbH) : 0;
    this.scrollY = Math.round(frac * this.maxScroll());
  }
};
var Input = class extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.value = "";
    this.cursor = 0;
    this.prompt = opts.prompt ?? "\u276F ";
    this.onEnter = opts.onEnter ?? null;
    this.onChange = null;
    this.placeholder = opts.placeholder ?? "";
    this.fg = opts.fg ?? 13949149;
    this.bg = opts.bg ?? -1;
    this.border = opts.border ?? T.BORDER2;
    this.multi = opts.multi ?? false;
    this.maxLines = opts.maxLines ?? 6;
    this.baseMaxLines = this.maxLines;
    this.expanded = false;
    this.app = opts.app ?? null;
    this.pendingPaste = null;
    this.pasteMark = null;
    this.atomicMarks = [];
    this.selStart = null;
    this.selEnd = null;
    this.commands = opts.commands ?? [];
    this.cmdOpen = false;
    this.cmdIdx = 0;
    this.cmds = [];
    this.onChange = opts.onChange ?? null;
    this.allowEmptyEnter = opts.allowEmptyEnter ?? false;
    this.history = [];
    this.histIdx = -1;
    this.masked = opts.masked ?? false;
  }
  #cps() {
    return graphemes(this.value);
  }
  // user-perceived characters
  /** Visual rows for multi-line input: logical lines wrapped at the width. */
  #visualRows() {
    const inner0 = Math.max(1, this.w - strWidth(this.prompt) - 2);
    const innerN = Math.max(1, this.w - 2);
    const rows = [];
    const cps = this.#cps();
    let text = "", width = 0, limit = inner0, start = 0;
    for (let i = 0; i < cps.length; i++) {
      const ch = cps[i];
      if (ch === "\n") {
        rows.push({ text, start, end: i, limit });
        text = "";
        width = 0;
        limit = innerN;
        start = i + 1;
        continue;
      }
      const cw = strWidth(ch);
      if (width + cw > limit && width > 0) {
        rows.push({ text, start, end: i, limit });
        text = "";
        width = 0;
        limit = innerN;
        start = i;
      }
      text += ch;
      width += cw;
    }
    rows.push({ text, start, end: cps.length, limit });
    return rows;
  }
  /** [visualRow, display-col] of the cursor in wrapped coordinates. */
  #cursorVisual() {
    const rows = this.#visualRows();
    const cursor = Math.max(0, Math.min(this.cursor, this.#cps().length));
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      if (cursor >= r.start && cursor <= r.end) {
        const before = graphemes(r.text).slice(0, cursor - r.start);
        return { row: ri, col: before.reduce((w, ch) => w + strWidth(ch), 0) };
      }
    }
    const last = rows[rows.length - 1];
    return { row: rows.length - 1, col: strWidth(last.text) };
  }
  /** Code-point index of the nearest position at a visual [row, col]. */
  #indexAtVisual(row, col) {
    const rows = this.#visualRows();
    const r = rows[Math.max(0, Math.min(row, rows.length - 1))];
    const cps = graphemes(r.text);
    let w = 0, j = 0;
    for (; j < cps.length; j++) {
      const cw = strWidth(cps[j]);
      if (col < w + cw / 2) break;
      w += cw;
    }
    return r.start + j;
  }
  /** Rendered height: 1, or wrapped rows capped at maxLines when multi. */
  height() {
    return this.multi ? Math.max(1, Math.min(this.maxLines, this.#visualRows().length)) : 1;
  }
  setValue(v, opts = {}) {
    this.#touch();
    this.value = String(v);
    this.cursor = this.#cps().length;
    this.selectAll = Boolean(opts.select);
    this.#updateCmds();
    this.onChange?.();
  }
  insertAtomic(text, id = null) {
    const at = this.selectAll ? 0 : this.cursor;
    this.insert(text);
    this.atomicMarks.push({ start: at, end: at + graphemes(text).length, id });
    this.#snapCursor(1);
  }
  removeAtomic(id) {
    const m = this.atomicMarks.find((x) => x.id === id);
    if (!m) return false;
    this.#edit(m.start, m.end, "");
    return true;
  }
  insert(text) {
    const at = this.selectAll ? 0 : this.cursor;
    if (this.selectAll) {
      this.selectAll = false;
      this.value = "";
      this.cursor = 0;
      this.#touch();
    }
    this.#edit(at, at, text);
  }
  /** The / command candidate bar opens while the value is a bare "/…" prefix. */
  #updateCmds() {
    const v = this.value;
    if (v.startsWith("/") && !v.includes(" ") && !v.includes("\n")) {
      this.cmds = this.commands.filter((c) => c.name.startsWith(v));
      if (this.cmds.length > 0) {
        this.cmdOpen = true;
        if (this.cmdIdx >= this.cmds.length) this.cmdIdx = 0;
        return;
      }
    }
    this.cmdOpen = false;
    this.cmdIdx = 0;
    this.cmds = [];
  }
  /** EVERY edit goes through here so the immutable paste token behaves as
   *  one unit: deleting any part of it removes it whole, typing inside it
   *  replaces it, edits elsewhere just shift it. Always notifies onChange —
   *  the second-paste swap must reflow the layout just like typing. */
  #edit(from, to, text = "") {
    this.selStart = this.selEnd = null;
    const cps = this.#cps();
    const t = graphemes(text);
    const atomic = this.atomicMarks.find((x) => to > x.start && from < x.end);
    if (atomic) {
      from = Math.min(from, atomic.start);
      to = Math.max(to, atomic.end);
      this.atomicMarks = this.atomicMarks.filter((x) => x !== atomic);
    }
    for (const mark of this.atomicMarks) {
      if (to <= mark.start) {
        const delta = graphemes(text).length - (to - from);
        mark.start += delta;
        mark.end += delta;
      }
    }
    const m = this.pasteMark;
    if (m && to > m.start && from < m.end) {
      const lo = Math.min(from, m.start);
      const hi = Math.max(to, m.end);
      cps.splice(lo, hi - lo, ...t);
      this.cursor = lo + t.length;
      this.pasteMark = null;
      this.pendingPaste = null;
      this.value = cps.join("");
      this.#updateCmds();
      this.onChange?.();
      return;
    }
    if (m && to <= m.start) {
      const delta = t.length - (to - from);
      m.start += delta;
      m.end += delta;
    }
    cps.splice(from, to - from, ...t);
    this.cursor = from + t.length;
    this.value = cps.join("");
    this.#updateCmds();
    this.onChange?.();
  }
  #deleteAt(idx) {
    this.#edit(idx, idx + 1);
  }
  /** Scroll offset that keeps the cursor's visual row inside the window. */
  #scrollStart(h) {
    const rows = this.#visualRows();
    const { row } = this.#cursorVisual();
    const maxStart = Math.max(0, rows.length - this.maxLines);
    let start = this.scrollY ?? 0;
    if (row < start) start = row;
    else if (row >= start + h) start = row - h + 1;
    start = Math.max(0, Math.min(maxStart, start));
    this.scrollY = start;
    return start;
  }
  render(screen) {
    if (!this.multi) {
      screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y, " ", { bg: this.bg });
      const promptW = strWidth(this.prompt);
      const inner = Math.max(0, this.w - promptW - 2);
      screen.text(this.x, this.y, this.prompt, { fg: T.ACCENT, bg: this.bg });
      if (this.value === "" && this.placeholder) {
        screen.text(this.x + promptW, this.y, truncate(this.placeholder, inner), { fg: T.FAINT, bg: this.bg });
        this.cursorCell = { x: this.x + promptW, y: this.y };
        return;
      }
      const cps = this.#cps();
      const before = cps.slice(0, this.cursor).join("");
      const cx = strWidth(before);
      const desiredCol = Math.max(0, cx - Math.max(1, inner - 1));
      let startIdx = 0, startCol = 0;
      while (startIdx < cps.length && startCol + strWidth(cps[startIdx]) <= desiredCol) {
        startCol += strWidth(cps[startIdx]);
        startIdx++;
      }
      const visible = truncate(cps.slice(startIdx).join(""), inner);
      const drawn = this.masked ? "\u2022".repeat(graphemes(visible).length) : visible;
      screen.text(this.x + promptW, this.y, drawn, { fg: this.fg, bg: this.bg });
      this.cursorCell = { x: this.x + promptW + Math.min(inner, Math.max(0, cx - startCol)), y: this.y };
      return;
    }
    const rows = this.#visualRows();
    const h = Math.min(this.maxLines, rows.length);
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + h - 1, " ", { bg: this.bg });
    if (this.value === "" && this.placeholder) {
      screen.text(this.x, this.y, this.prompt, { fg: T.ACCENT, bg: this.bg });
      screen.text(this.x + strWidth(this.prompt), this.y, truncate(this.placeholder, this.w - strWidth(this.prompt) - 2), { fg: T.FAINT, bg: this.bg });
      this.cursorCell = { x: this.x + strWidth(this.prompt), y: this.y };
      return;
    }
    const { row: curRow, col: curCol } = this.#cursorVisual();
    const start = this.#scrollStart(h);
    for (let ri = start; ri < Math.min(rows.length, start + h); ri++) {
      const r = rows[ri];
      const y = this.y + (ri - start);
      const drawn = this.masked ? "\u2022".repeat(graphemes(r.text).length) : r.text;
      if (ri === 0) {
        screen.text(this.x, y, this.prompt, { fg: T.ACCENT, bg: this.bg });
        screen.text(this.x + strWidth(this.prompt), y, drawn, { fg: this.fg, bg: this.bg });
      } else {
        screen.text(this.x + 1, y, drawn, { fg: this.fg, bg: this.bg });
      }
    }
    if (this.selStart !== null && this.selEnd !== null && this.selEnd > this.selStart) {
      for (let ri = start; ri < Math.min(rows.length, start + h); ri++) {
        const r = rows[ri];
        const lo = Math.max(r.start, this.selStart);
        const hi = Math.min(r.end, this.selEnd);
        if (lo >= hi) continue;
        const rowY = this.y + (ri - start);
        const text = graphemes(r.text);
        const preW = strWidth(text.slice(0, lo - r.start).join(""));
        const selW = strWidth(text.slice(lo - r.start, hi - r.start).join(""));
        const x0 = this.x + (ri === 0 ? strWidth(this.prompt) : 1) + preW;
        screen.invertRect(x0, rowY, Math.min(this.x + this.w - 1, x0 + Math.max(0, selW - 1)), rowY);
      }
    }
    const curY = this.y + (curRow - start);
    const curX = curRow === 0 ? this.x + strWidth(this.prompt) + curCol : this.x + 1 + curCol;
    this.cursorCell = { x: Math.min(this.x + this.w - 1, curX), y: Math.min(this.y + h - 1, curY) };
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      if (this.multi) {
        const h = this.height();
        const start = this.scrollY ?? 0;
        const row = start + Math.max(0, Math.min(h - 1, ev.y - this.y));
        const rx = ev.x - this.x - (row === 0 ? strWidth(this.prompt) : 1);
        this.cursor = this.#indexAtVisual(row, Math.max(0, rx));
        this.#snapCursor();
      } else {
        const rx = ev.x - this.x - strWidth(this.prompt);
        let w = 0, idx = 0;
        for (const ch of this.#cps()) {
          const cw = strWidth(ch);
          if (rx < w + cw / 2) break;
          w += cw;
          idx++;
        }
        this.cursor = idx;
        this.#snapCursor();
      }
      this.selStart = this.cursor;
      this.selEnd = this.cursor;
      return true;
    }
    if ((ev.kind === "drag" || ev.kind === "release") && ev.button === 0 && this.selStart !== null) {
      if (this.multi) {
        const h = this.height();
        const start = this.scrollY ?? 0;
        const row = start + Math.max(0, Math.min(h - 1, ev.y - this.y));
        const rx = ev.x - this.x - (row === 0 ? strWidth(this.prompt) : 1);
        this.cursor = this.#indexAtVisual(row, Math.max(0, rx));
      } else {
        const rx = ev.x - this.x - strWidth(this.prompt);
        let w = 0, idx = 0;
        for (const ch of this.#cps()) {
          const cw = strWidth(ch);
          if (rx < w + cw / 2) break;
          w += cw;
          idx++;
        }
        this.cursor = idx;
      }
      this.#snapCursor();
      this.selEnd = this.cursor;
      if (this.selEnd < this.selStart) {
        const t = this.selStart;
        this.selStart = this.selEnd;
        this.selEnd = t;
      }
      return true;
    }
    return false;
  }
  /** The paste token is a single cursor unit: the caret never rests inside
   *  its span — LEFT from the end hops to its start, RIGHT from the start
   *  hops to its end, and clicks/moves snap to the nearest boundary.
   *  dir: -1 = leftward movement → start, +1 = rightward → end, 0 = nearest. */
  #snapCursor(dir = 0) {
    const marks = [...this.atomicMarks, ...this.pasteMark ? [this.pasteMark] : []];
    const m = marks.find((x) => this.cursor > x.start && this.cursor < x.end);
    if (!m) return;
    if (this.cursor > m.start && this.cursor < m.end) {
      if (dir < 0) this.cursor = m.start;
      else if (dir > 0) this.cursor = m.end;
      else this.cursor = this.cursor - m.start < m.end - this.cursor ? m.start : m.end;
    }
  }
  /** Cancel the held-back paste AND its token. */
  #touch() {
    this.pendingPaste = null;
    this.pasteMark = null;
  }
  /** Claude-Code-style two-stage paste: the first Ctrl+Shift+V of a large
   *  clipboard shows a "[已复制 N 行内容]" placeholder — an IMMUTABLE token:
   *  deleting/typing into it consumes it whole, edits around it keep it, and
   *  pasting the same content again replaces exactly that token. */
  #paste(text) {
    text = String(text ?? "");
    const large = text.includes("\n") || text.length > 300;
    if (large) {
      if (this.pendingPaste && this.pendingPaste.text === text) {
        const full = this.pendingPaste.text;
        const m = this.pasteMark;
        this.#touch();
        if (m) this.#edit(m.start, m.end, full);
        else this.insert(full);
        this.app?.toast?.("\u5DF2\u7C98\u8D34\u5B8C\u6574\u5185\u5BB9");
        return true;
      }
      const lines = text.split("\n").length;
      const placeholder = `[\u5DF2\u590D\u5236 ${lines} \u884C\u5185\u5BB9]`;
      const at = this.selectAll ? 0 : this.cursor;
      this.insert(placeholder);
      this.pasteMark = { start: at, end: at + graphemes(placeholder).length };
      this.pendingPaste = { text };
      this.app?.toast?.("\u518D\u6B21 Ctrl+Shift+V \u7C98\u8D34\u5B8C\u6574\u5185\u5BB9\uFF08Ctrl+L \u5C55\u5F00\u8F93\u5165\u680F\uFF09");
      return true;
    }
    this.#touch();
    this.insert(text);
    return true;
  }
  onKey(ev) {
    if (ev.type === "text" || ev.type === "paste") {
      return this.#paste(ev.text ?? "");
    }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "backspace":
        if (this.cursor > 0) this.#edit(this.cursor - 1, this.cursor);
        return true;
      case "delete":
        if (this.cursor < this.#cps().length) this.#edit(this.cursor, this.cursor + 1);
        return true;
      case "left":
        this.selectAll = false;
        this.selStart = this.selEnd = null;
        this.cursor = Math.max(0, this.cursor - 1);
        this.#snapCursor(-1);
        return true;
      case "right":
        this.selectAll = false;
        this.selStart = this.selEnd = null;
        this.cursor = Math.min(this.#cps().length, this.cursor + 1);
        this.#snapCursor(1);
        return true;
      case "home": {
        this.selStart = this.selEnd = null;
        if (this.multi) {
          const rows = this.#visualRows();
          const { row } = this.#cursorVisual();
          this.cursor = rows[row].start;
        } else this.cursor = 0;
        this.#snapCursor();
        return true;
      }
      case "end": {
        this.selStart = this.selEnd = null;
        if (this.multi) {
          const rows = this.#visualRows();
          const { row } = this.#cursorVisual();
          this.cursor = rows[row].end;
        } else this.cursor = this.#cps().length;
        this.#snapCursor();
        return true;
      }
      case "up": {
        this.selStart = this.selEnd = null;
        if (this.cmdOpen && this.cmds.length) {
          this.cmdIdx = (this.cmdIdx - 1 + this.cmds.length) % this.cmds.length;
          this.onChange?.();
          return true;
        }
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row > 0) {
            this.cursor = this.#indexAtVisual(row - 1, col);
            this.#snapCursor();
            return true;
          }
        }
        if (this.history.length) {
          this.histIdx = this.histIdx < 0 ? this.history.length - 1 : Math.max(0, this.histIdx - 1);
          this.setValue(this.history[this.histIdx] ?? "");
        }
        return true;
      }
      case "down": {
        this.selStart = this.selEnd = null;
        if (this.cmdOpen && this.cmds.length) {
          this.cmdIdx = (this.cmdIdx + 1) % this.cmds.length;
          this.onChange?.();
          return true;
        }
        if (this.multi) {
          const rows = this.#visualRows();
          const { row, col } = this.#cursorVisual();
          if (row < rows.length - 1) {
            this.cursor = this.#indexAtVisual(row + 1, col);
            this.#snapCursor();
            return true;
          }
        }
        if (this.histIdx >= 0) {
          this.histIdx++;
          if (this.histIdx >= this.history.length) {
            this.histIdx = -1;
            this.setValue("");
          } else this.setValue(this.history[this.histIdx]);
        }
        return true;
      }
      case "tab":
        if (this.cmdOpen && this.cmds.length) {
          const c = this.cmds[this.cmdIdx];
          this.setValue(c.name + " ");
          this.cmdOpen = false;
          return true;
        }
        return false;
      case "char":
        if (ev.ctrl) {
          switch (ev.key) {
            case "j":
              if (this.multi) {
                this.insert("\n");
                return true;
              }
              return false;
            case "c": {
              if (ev.shift) {
                if (this.selStart !== null && this.selEnd !== null && this.selEnd > this.selStart) {
                  const text = this.#cps().slice(this.selStart, this.selEnd).join("");
                  this.selStart = this.selEnd = null;
                  this.app?.copyText?.(text);
                } else {
                  this.app?.toast?.("\u5148\u7528\u9F20\u6807\u62D6\u52A8\u9009\u4E2D\u8981\u590D\u5236\u7684\u5185\u5BB9");
                }
                return true;
              }
              this.#touch();
              this.value = "";
              this.cursor = 0;
              this.selectAll = false;
              this.onChange?.();
              this.app?.toast?.("\u5DF2\u6E05\u7A7A\u8F93\u5165\u680F");
              return true;
            }
            case "u":
              this.#edit(0, this.cursor);
              return true;
            case "k":
              this.#edit(this.cursor, this.#cps().length);
              return true;
            case "l": {
              this.expanded = !this.expanded;
              this.maxLines = this.expanded ? 1e3 : this.baseMaxLines;
              this.onChange?.();
              this.app?.toast?.(this.expanded ? "\u8F93\u5165\u680F\u5DF2\u5C55\u5F00\uFF08Ctrl+L \u6298\u53E0\uFF09" : "\u8F93\u5165\u680F\u5DF2\u6298\u53E0\uFF08Ctrl+L \u5C55\u5F00\uFF09");
              return true;
            }
            case "a":
              this.cursor = 0;
              return true;
            case "e":
              this.cursor = this.#cps().length;
              return true;
            case "w": {
              const cps = this.#cps();
              let idx = this.cursor;
              while (idx > 0 && /\s/.test(cps[idx - 1])) idx--;
              while (idx > 0 && !/\s/.test(cps[idx - 1])) idx--;
              cps.splice(idx, this.cursor - idx);
              this.value = cps.join("");
              this.cursor = idx;
              this.onChange?.();
              return true;
            }
          }
          return false;
        }
        this.insert(ev.text);
        return true;
      case "enter":
        if (ev.shift && this.multi) {
          this.insert("\n");
          return true;
        }
        if (this.value.trim() === "" && !this.allowEmptyEnter) return false;
        const v = this.value;
        this.#touch();
        this.history.push(v);
        this.histIdx = -1;
        this.value = "";
        this.cursor = 0;
        this.onChange?.();
        this.onEnter?.(v);
        return true;
    }
    return false;
  }
};
var Popup = class extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.title = opts.title ?? "";
    this.lines = opts.lines ?? [];
    this.buttons = opts.buttons ?? [];
    this.btnIdx = 0;
    this.onAction = opts.onAction ?? null;
    this.fg = opts.fg;
    this.scrollable = opts.scrollable ?? false;
    this.scrollY = 0;
  }
  contentRows() {
    return this.h - 2 - (this.buttons.length ? 1 : 0);
  }
  maxScroll() {
    return Math.max(0, this.lines.length - this.contentRows());
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: this.fg ?? 6797311, bg: T.BG2 }, this.title);
    let ly = this.y + 1;
    const draw = (line) => {
      if (Array.isArray(line)) {
        let px = this.x + 2;
        for (const seg of line) {
          if (typeof seg !== "object" || seg === null || typeof seg.t !== "string") continue;
          const tx = truncate(seg.t, this.x + this.w - 2 - px);
          if (tx) screen.text(px, ly, tx, {
            fg: seg.fg,
            bg: seg.bg ?? T.BG2,
            attrs: (seg.bold ? 1 : 0) | (seg.italic ? 4 : 0) | (seg.underline ? 8 : 0)
          });
          px += strWidth(tx);
        }
      } else {
        screen.text(this.x + 2, ly, truncate(String(line), this.w - 4), { fg: T.TXT, bg: T.BG2 });
      }
      ly++;
    };
    if (this.scrollable) {
      const avail = this.contentRows();
      this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
      const start = this.scrollY;
      for (let i = 0; i < avail; i++) {
        const line = this.lines[start + i];
        if (line === void 0) break;
        draw(line);
      }
      if (this.maxScroll() > 0) {
        if (this.scrollY > 0) screen.text(this.x + this.w - 10, this.y, ` \u2191 ${this.scrollY}/${this.lines.length}`, { fg: T.ACCENT, bg: T.BG2 });
        if (this.scrollY < this.maxScroll()) screen.text(this.x + this.w - 12, this.y + this.h - 1, ` \u2193 ${this.scrollY + this.contentRows()}/${this.lines.length}`, { fg: T.ACCENT, bg: T.BG2 });
      }
    } else {
      for (const line of this.lines) draw(line);
    }
    if (this.buttons.length) {
      let bx = this.x + 2;
      const by = this.y + this.h - 2;
      this.buttons.forEach((b, i) => {
        const label = ` ${b.label} `;
        const sel = i === this.btnIdx;
        screen.text(bx, by, label, {
          fg: sel ? T.SELFG : T.TXT,
          bg: sel ? T.ACCENT : T.MENUSEL,
          attrs: 1
        });
        bx += strWidth(label) + 1;
      });
    }
  }
  onMouse(ev) {
    if (this.scrollable) {
      if (ev.kind === "wheel-up") {
        this.scrollY = Math.max(0, this.scrollY - 3);
        return true;
      }
      if (ev.kind === "wheel-down") {
        this.scrollY = Math.min(this.maxScroll(), this.scrollY + 3);
        return true;
      }
    }
    if (ev.kind === "press" && ev.button === 0 && this.buttons.length) {
      let bx = this.x + 2;
      const by = this.y + this.h - 2;
      for (let i = 0; i < this.buttons.length; i++) {
        const label = ` ${this.buttons[i].label} `;
        if (ev.y === by && ev.x >= bx && ev.x < bx + strWidth(label)) {
          this.onAction?.(this.buttons[i], i);
          return true;
        }
        bx += strWidth(label) + 1;
      }
    }
    return false;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (this.scrollable) {
      if (ev.name === "up") {
        this.scrollY = Math.max(0, this.scrollY - 1);
        return true;
      }
      if (ev.name === "down") {
        this.scrollY = Math.min(this.maxScroll(), this.scrollY + 1);
        return true;
      }
      if (ev.name === "pgup") {
        this.scrollY = Math.max(0, this.scrollY - this.contentRows());
        return true;
      }
      if (ev.name === "pgdn") {
        this.scrollY = Math.min(this.maxScroll(), this.scrollY + this.contentRows());
        return true;
      }
    }
    if (ev.name === "escape") {
      this.onAction?.({ label: "__cancel__", action: "__cancel__" }, -1);
      return true;
    }
    if (ev.name === "tab" || ev.name === "right") {
      this.btnIdx = wrapIndex(this.btnIdx + 1, this.buttons.length);
      return true;
    }
    if (ev.name === "backtab" || ev.name === "left") {
      this.btnIdx = wrapIndex(this.btnIdx - 1, this.buttons.length);
      return true;
    }
    if (ev.name === "enter" && this.buttons[this.btnIdx]) {
      this.onAction?.(this.buttons[this.btnIdx], this.btnIdx);
      return true;
    }
    return false;
  }
};
var Menu = class extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.items = opts.items ?? [];
    this.sel = 0;
    this.onAction = opts.onAction ?? null;
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.MENUBG });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.MENUBG });
    this.items.forEach((it, i) => {
      const sel = i === this.sel;
      screen.fillRect(this.x + 1, this.y + 1 + i, this.x + this.w - 2, this.y + 1 + i, " ", { bg: sel ? T.MENUSEL : T.MENUBG });
      screen.text(this.x + 2, this.y + 1 + i, truncate(it.label, this.w - 4), {
        fg: sel ? 16777215 : it.danger ? T.ERR : T.TXT,
        bg: sel ? T.MENUSEL : T.MENUBG
      });
      if (it.hint) screen.text(this.x + this.w - 2 - strWidth(it.hint), this.y + 1 + i, it.hint, { fg: T.DIM, bg: sel ? T.MENUSEL : T.MENUBG });
    });
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const idx = ev.y - this.y - 1;
      if (idx >= 0 && idx < this.items.length) {
        this.onAction?.(this.items[idx], idx);
        return true;
      }
      return true;
    }
    return ev.x >= this.x && ev.x < this.x + this.w && ev.y >= this.y && ev.y < this.y + this.h;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up":
        this.sel = wrapIndex(this.sel - 1, this.items.length);
        return true;
      case "down":
        this.sel = wrapIndex(this.sel + 1, this.items.length);
        return true;
      case "enter":
        if (this.items[this.sel]) {
          this.onAction?.(this.items[this.sel], this.sel);
          return true;
        }
        return false;
      case "escape":
        this.onAction?.(null, -1);
        return true;
    }
    return false;
  }
};
var StatusBar = class extends Widget {
  constructor(opts = {}) {
    super(opts);
    this.rows = [];
  }
  render(screen) {
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const y = this.y + r;
      screen.fillRect(this.x, y, this.x + this.w - 1, y, " ", { bg: T.STATUSBG });
      let px = this.x;
      for (const seg of row.left ?? []) {
        const t = truncate(seg.t, this.x + this.w - px - 4);
        if (!t) break;
        screen.text(px, y, t, { fg: seg.fg ?? T.DIM, bg: seg.bg ?? T.STATUSBG, attrs: seg.bold ? 1 : 0 });
        px += strWidth(t);
      }
      let rx = this.x + this.w;
      for (let i = (row.right ?? []).length - 1; i >= 0; i--) {
        const seg = row.right[i];
        const t = truncate(seg.t, Math.max(0, rx - px - 2));
        if (!t) continue;
        rx -= strWidth(t);
        if (rx >= px) {
          screen.text(rx, y, t, { fg: seg.fg ?? T.DIM, bg: seg.bg ?? T.STATUSBG, attrs: seg.bold ? 1 : 0 });
        }
      }
    }
  }
};

// vendor/dsh-neotui/src/file-picker.js
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var import_node_os2 = require("node:os");
var import_node_child_process2 = require("node:child_process");
var ICON = { dir: "\u{F024B}", image: "\u{F02E9}", text: "\u{F0219}", pdf: "\u{F0226}", archive: "\u{F003C}", audio: "\u{F0386}", video: "\u{F0567}", file: "\u{F0214}" };
var IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
var TEXT = /\.(txt|md|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|conf|cfg|css|html?|xml|sh|bash|zsh|fish|py|rs|go|java|c|cc|cpp|h|hpp|log|csv|license)$/i;
function fileKind(path, dir) {
  if (dir) return "dir";
  if (IMAGE.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (TEXT.test(path) || /(^|\/)LICENSE(?:\..*)?$/i.test(path)) return "text";
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(path)) return "archive";
  if (/\.(mp3|flac|wav|ogg|m4a)$/i.test(path)) return "audio";
  if (/\.(mp4|mkv|webm|mov|avi)$/i.test(path)) return "video";
  try {
    const mime = (0, import_node_child_process2.execFileSync)("file", ["-Lb", "--mime-type", path], { encoding: "utf8", timeout: 500 }).trim();
    if (mime.startsWith("text/") || /(?:json|xml|javascript|yaml)/.test(mime)) return "text";
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
  } catch {
  }
  return "file";
}
function expandPath(input) {
  let value = String(input ?? "").trim();
  value = value.replace(/^~(?=\/|$)/, (0, import_node_os2.homedir)());
  value = value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, a, b) => process.env[a || b] ?? "");
  return (0, import_node_path4.resolve)(value);
}
function directoryRows(path, hidden = false) {
  return (0, import_node_fs4.readdirSync)(path, { withFileTypes: true }).filter((e) => hidden || !e.name.startsWith(".")).map((e) => {
    const full = (0, import_node_path4.join)(path, e.name), dir = e.isDirectory();
    return { name: e.name, path: full, dir, kind: fileKind(full, dir) };
  }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
var YnPopup = class extends Popup {
  onKey(ev) {
    const key = ev.type === "text" ? ev.text : ev.type === "key" && ev.name === "char" ? ev.key : null;
    if (key === "y" || key === "n") {
      const action = key === "y" ? "yes" : "no";
      this.onAction?.({ action, label: key }, action === "yes" ? 0 : 1);
      return true;
    }
    return super.onKey(ev);
  }
};
var UploadPicker = class extends Widget {
  constructor(app, { startPath, onUpload, onCancel, selectDirectories = false, onPickDirectory = null }) {
    const w = Math.min(app.screen.w - 4, 120), h = Math.min(app.screen.h - 4, 34);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.path = startPath;
    this.onUpload = onUpload;
    this.onCancel = onCancel;
    this.selectDirectories = selectDirectories;
    this.onPickDirectory = onPickDirectory;
    this.all = [];
    this.sel = 0;
    this.selected = /* @__PURE__ */ new Map();
    this.filter = "";
    this.filterInput = null;
    this.showHidden = false;
    this.pathPopup = null;
    this.imagePreview = null;
    this.load();
  }
  load(selectName = null) {
    try {
      this.all = directoryRows(this.path, this.showHidden);
    } catch (e) {
      this.all = [];
      this.app.toast(`\u8BFB\u53D6\u5931\u8D25: ${e.message}`);
    }
    this.sel = selectName ? Math.max(0, this.all.findIndex((x) => x.name === selectName)) : 0;
    this.app.redraw();
  }
  items() {
    const q = this.filter.toLowerCase();
    return q ? this.all.filter((x) => x.name.toLowerCase().includes(q)) : this.all;
  }
  current() {
    return this.items()[this.sel];
  }
  changePath(path, selectName = null) {
    if (this.selected.size) {
      this.confirmAbandon(path, selectName);
      return;
    }
    this.clearKitty();
    this.path = path;
    this.filter = "";
    this.load(selectName);
  }
  confirmAbandon(path, selectName) {
    const back = this;
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 5, w: this.w - 20, h: 7, title: "\u653E\u5F03\u5DF2\u9009\u62E9\u6587\u4EF6\uFF1F", lines: [`\u5DF2\u9009\u62E9 ${this.selected.size} \u4E2A\u6587\u4EF6\u3002\u5207\u6362\u76EE\u5F55\u4F1A\u6E05\u7A7A\u9009\u62E9\u3002`], buttons: [{ label: "\u662F (y)", action: "yes" }, { label: "\u5426 (n)", action: "no" }], onAction(b) {
      if (b.action === "yes") {
        back.clearKitty();
        back.selected.clear();
        back.path = path;
        back.filter = "";
        back.load(selectName);
      }
      back.app.overlay = back;
      back.app.focus(back);
      back.app.redraw();
    } });
    this.app.focus(this.app.overlay);
  }
  goParent() {
    const old = this.path;
    this.changePath((0, import_node_path4.dirname)(old), (0, import_node_path4.basename)(old));
  }
  enterDir() {
    const it = this.current();
    if (it?.dir) this.changePath(it.path);
  }
  toggle() {
    const it = this.current();
    if (!it) return;
    if (this.selectDirectories) {
      if (!it.dir) {
        this.app.toast("\u53EA\u80FD\u9009\u62E9\u6587\u4EF6\u5939");
        return;
      }
      this.confirmDirectory(it.path);
      return;
    }
    if (it.dir) {
      this.app.toast("\u4E0D\u53EF\u9009\u62E9\u6587\u4EF6\u5939");
      return;
    }
    if (this.selected.has(it.path)) this.selected.delete(it.path);
    else this.selected.set(it.path, it);
    this.app.redraw();
  }
  confirmDirectory(path) {
    const back = this;
    this.app.overlay = new YnPopup({ x: this.x + 8, y: this.y + 5, w: this.w - 16, h: 8, title: "\u6DFB\u52A0\u65B0\u5DE5\u4F5C\u533A\uFF1F", lines: [`\u662F\u5426\u5C06\u4EE5\u4E0B\u76EE\u5F55\u6DFB\u52A0\u4E3A\u65B0\u5DE5\u4F5C\u533A\uFF1A`, path], buttons: [{ label: "\u786E\u5B9A (y)", action: "yes" }, { label: "\u53D6\u6D88 (n)", action: "no" }], onAction(b) {
      if (b.action === "yes") back.onPickDirectory?.(path);
      back.app.overlay = back;
      back.app.focus(back);
      back.app.redraw();
    } });
    this.app.focus(this.app.overlay);
  }
  confirmUpload() {
    this.clearKitty();
    if (!this.selected.size) {
      this.app.toast("\u8BF7\u5148\u6309 Space \u9009\u62E9\u6587\u4EF6");
      return;
    }
    const back = this, list = [...this.selected.values()], shown = list.slice(0, 5).map((x) => x.name);
    this.app.overlay = new YnPopup({ x: this.x + 10, y: this.y + 4, w: this.w - 20, h: Math.min(12, shown.length + 6), title: "\u786E\u8BA4\u4E0A\u4F20\u6587\u4EF6", lines: [...shown, `\u5171 ${list.length} \u4E2A\u6587\u4EF6`], buttons: [{ label: "\u786E\u5B9A (y)", action: "yes" }, { label: "\u53D6\u6D88 (n)", action: "no" }], onAction(b) {
      if (b.action === "yes") {
        back.selected.clear();
        back.onUpload?.(list);
      }
      back.app.overlay = back;
      back.app.focus(back);
      back.app.redraw();
    } });
    this.app.focus(this.app.overlay);
  }
  startFilter() {
    this.filterInput = new Input({ x: this.x + 2, y: this.y + this.h - 2, w: Math.min(38, Math.max(18, Math.floor(this.w * 0.35))), h: 1, prompt: "/", onChange: () => {
      if (this.filterInput) {
        this.filter = this.filterInput.value;
        this.sel = 0;
        this.app.redraw();
      }
    }, onEnter: (value) => {
      this.filter = value;
      this.filterInput = null;
      this.sel = Math.min(this.sel, Math.max(0, this.items().length - 1));
      this.app.focus(this);
      this.app.redraw();
    } });
    this.app.focus(this.filterInput);
  }
  editPath() {
    const parent = this;
    const popup = new Popup({ x: this.x + 6, y: this.y + 3, w: this.w - 12, h: 5, title: "\u7F16\u8F91\u8DEF\u5F84 \xB7 \u652F\u6301 ~ / $HOME \xB7 Enter \u786E\u5B9A \xB7 Esc \u53D6\u6D88", lines: [], buttons: [] });
    const input = new Input({ x: popup.x + 2, y: popup.y + 2, w: popup.w - 4, h: 1, prompt: "\u8DEF\u5F84: ", allowEmptyEnter: true, onEnter: (v) => {
      parent.pathPopup = null;
      parent.app.overlay = parent;
      parent.app.focus(parent);
      if (v.trim()) parent.changePath(expandPath(v));
    } });
    input.setValue(this.path, { select: false });
    popup.input = input;
    popup.render = (screen) => {
      Popup.prototype.render.call(popup, screen);
      input.render(screen);
    };
    popup.onKey = (ev) => {
      if (ev.type === "key" && ev.name === "escape") {
        parent.pathPopup = null;
        parent.app.overlay = parent;
        parent.app.focus(parent);
        parent.app.redraw();
        return true;
      }
      return input.onKey(ev);
    };
    this.pathPopup = popup;
    this.app.overlay = popup;
    this.app.focus(input);
    this.app.redraw();
  }
  preview(it, width, height) {
    if (!it) return ["\uFF08\u7A7A\uFF09"];
    if (it.dir) {
      try {
        return directoryRows(it.path, this.showHidden).slice(0, height).map((x) => `${ICON[x.kind]} ${x.name}`);
      } catch {
        return ["\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55"];
      }
    }
    try {
      if (it.kind === "text") return (0, import_node_fs4.readFileSync)(it.path, "utf8").split("\n").slice(0, height).map((x) => truncate(x, width));
      if (it.kind === "pdf") {
        const text = (0, import_node_child_process2.execFileSync)("pdftotext", ["-f", "1", "-l", "2", it.path, "-"], { encoding: "utf8", timeout: 3e3 });
        return text.split("\n").filter(Boolean).slice(0, height).map((x) => truncate(x, width));
      }
      const st = (0, import_node_fs4.statSync)(it.path);
      if (it.kind === "image") {
        let info = "";
        try {
          info = (0, import_node_child_process2.execFileSync)("magick", ["identify", "-format", "%m \xB7 %wx%h", it.path], { encoding: "utf8", timeout: 2e3 });
        } catch {
        }
        let pixelWidth = 0, pixelHeight = 0;
        const dims = /([0-9]+)x([0-9]+)/.exec(info);
        if (dims) {
          pixelWidth = Number(dims[1]);
          pixelHeight = Number(dims[2]);
        }
        this.imagePreview = { path: it.path, key: `${it.path}:${st.mtimeMs}`, width, height: Math.max(4, height - 3), pixelWidth, pixelHeight, pixelInfo: info };
        return [info, `${st.size} bytes`, this.app.term?.kitty ? "Kitty \u56FE\u7247\u9884\u89C8" : "\u7EC8\u7AEF\u4E0D\u652F\u6301 Kitty\uFF1B\u663E\u793A\u56FE\u7247\u4FE1\u606F"];
      }
      return [`${ICON[it.kind]} ${it.name}`, `${st.size} bytes`, "\u65E0\u6587\u672C\u9884\u89C8"];
    } catch (e) {
      return [`\u9884\u89C8\u5931\u8D25: ${e.message}`];
    }
  }
  centeredStart(count, height) {
    return Math.max(0, Math.min(Math.max(0, count - height), this.sel - Math.floor(height / 2)));
  }
  kittyTransmit() {
    const p = this.imagePreview;
    if (!p || !this.app.term?.kitty) return "";
    if (this.kittyShownKey === p.key) return "";
    if (this.kittyId && this.app.term?.output) this.app.term.output.write(`\x1B_Ga=d,d=i,i=${this.kittyId},q=2\x1B\\`);
    this.kittyId = Math.floor(Math.random() * 2147483646) + 1;
    this.kittyShownKey = p.key;
    let data;
    try {
      data = (0, import_node_fs4.readFileSync)(p.path);
      if (!/\.png$/i.test(p.path)) {
        const r = (0, import_node_child_process2.spawnSync)("magick", ["-", "png:-"], { input: data, maxBuffer: 32 * 1024 * 1024 });
        if (r.status === 0) data = r.stdout;
      }
    } catch {
      return "";
    }
    const b64 = data.toString("base64"), chunks = [];
    for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
    const payload = chunks.map((c, i) => i === 0 ? `\x1B_Ga=t,f=100,i=${this.kittyId},q=2,m=${chunks.length === 1 ? 0 : 1};${c}\x1B\\` : `\x1B_Gm=${i === chunks.length - 1 ? 0 : 1};${c}\x1B\\`).join("");
    const inner = this.w - 4, l = Math.floor(inner * 0.25), m = Math.floor(inner * 0.38), x = this.x + 5 + l + m, y = this.y + 4;
    const sourceAspect = p.pixelWidth && p.pixelHeight ? p.pixelWidth / p.pixelHeight : 1;
    let cols = Math.max(4, p.width), rows = Math.max(3, Math.round(cols / sourceAspect / 2));
    if (rows > p.height) {
      rows = Math.max(3, p.height);
      cols = Math.max(4, Math.min(p.width, Math.round(rows * sourceAspect * 2)));
    }
    return payload + `\x1B[${y};${x}H\x1B_Ga=p,i=${this.kittyId},c=${cols},r=${rows},q=2\x1B\\`;
  }
  clearKitty() {
    if (this.kittyId && this.app.term?.output) this.app.term.output.write(`\x1B_Ga=d,d=i,i=${this.kittyId},q=2\x1B\\`);
    this.kittyId = null;
    this.kittyShownKey = null;
    this.imagePreview = null;
    if (this.app.screen) {
      this.app.screen.prev = null;
      this.app.redraw();
    }
  }
  render(s) {
    this.imagePreview = null;
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.BG2 }, `${truncate(this.path, this.w - 22)}  Ctrl+F \u7F16\u8F91\u8DEF\u5F84`);
    const inner = this.w - 4, l = Math.floor(inner * 0.25), m = Math.floor(inner * 0.38), r = inner - l - m - 2, y0 = this.y + 1, h = this.h - 3;
    s.vline(this.x + 2 + l, y0, y0 + h - 1, "\u2502", { fg: T.BORDER2, bg: T.BG2 });
    s.vline(this.x + 3 + l + m, y0, y0 + h - 1, "\u2502", { fg: T.BORDER2, bg: T.BG2 });
    let parent = [];
    try {
      parent = directoryRows((0, import_node_path4.dirname)(this.path), this.showHidden);
    } catch {
    }
    const parentIdx = parent.findIndex((x) => x.path === this.path), parentStart = Math.max(0, Math.min(Math.max(0, parent.length - h), parentIdx - Math.floor(h / 2)));
    parent.slice(parentStart, parentStart + h).forEach((x, i) => {
      const on = x.path === this.path, y = y0 + i;
      if (on) s.fillRect(this.x + 1, y, this.x + 1 + l, y, " ", { bg: T.MENUSEL });
      s.text(this.x + 2, y, truncate(`${ICON[x.kind]} ${x.name}`, l - 1), { fg: on ? T.SELFG : T.DIM, bg: on ? T.MENUSEL : T.BG2 });
    });
    const its = this.items(), start = this.centeredStart(its.length, h);
    its.slice(start, start + h).forEach((x, i) => {
      const idx = start + i, on = idx === this.sel, chosen = this.selected.has(x.path), y = y0 + i;
      s.fillRect(this.x + 3 + l, y, this.x + 2 + l + m, y, " ", { bg: on ? T.MENUSEL : T.BG2 });
      s.text(this.x + 4 + l, y, truncate(`${chosen ? "->" : "  "} ${ICON[x.kind]} ${x.name}`, m - 2), { fg: on ? T.SELFG : chosen ? T.OK : T.TXT, bg: on ? T.MENUSEL : T.BG2 });
    });
    this.preview(this.current(), r - 2, h).forEach((x, i) => s.text(this.x + 5 + l + m, y0 + i, truncate(x, r - 2), { fg: T.DIM, bg: T.BG2 }));
    const foot = this.filterInput ? `\u7B5B\u9009\u4E2D \xB7 Ctrl+/ \u6E05\u9664\u5E76\u9000\u51FA \xB7 Enter \u56FA\u5B9A\u7ED3\u679C \xB7 \u2190/\u2192 \u5207\u6362\u76EE\u5F55` : this.selectDirectories ? `\u2191\u2193 \u9009\u62E9 \xB7 \u2190/\u2192 \u76EE\u5F55 \xB7 Space \u9009\u62E9\u5DE5\u4F5C\u533A \xB7 / \u7B5B\u9009 \xB7 Ctrl+F \u8DEF\u5F84 \xB7 Ctrl+. \u9690\u85CF\u9879 \xB7 Esc \u53D6\u6D88` : `\u2191\u2193 \u9009\u62E9 \xB7 \u2190/\u2192 \u76EE\u5F55 \xB7 Space \u591A\u9009 \xB7 Enter \u4E0A\u4F20 \xB7 / \u7B5B\u9009 \xB7 Ctrl+F \u8DEF\u5F84 \xB7 Ctrl+. \u9690\u85CF\u9879 \xB7 Ctrl+/ \u6E05\u7B5B\u9009 \xB7 Esc \u53D6\u6D88`;
    const footX = this.filterInput ? this.x + 3 + this.filterInput.w : this.x + 2;
    s.text(footX, this.y + this.h - 2, truncate(foot, this.x + this.w - 2 - footX), { fg: T.FAINT, bg: T.BG2 });
    if (this.filterInput) this.filterInput.render(s);
  }
  onKey(ev) {
    if (this.filterInput) {
      if (ev.type === "key" && ev.ctrl && (ev.key === "/" || ev.key === "_")) {
        this.filterInput = null;
        this.filter = "";
        this.sel = 0;
        this.app.focus(this);
        this.app.redraw();
        return true;
      }
      if (ev.type === "key" && ev.name === "left") {
        this.filter = this.filterInput.value;
        this.filterInput = null;
        this.app.focus(this);
        this.goParent();
        return true;
      }
      if (ev.type === "key" && ev.name === "right") {
        this.filter = this.filterInput.value;
        this.filterInput = null;
        this.app.focus(this);
        this.enterDir();
        return true;
      }
      return this.filterInput.onKey(ev);
    }
    const text = ev.type === "text" ? ev.text : null;
    if (text === " ") {
      this.toggle();
      return true;
    }
    if (text === "/") {
      this.startFilter();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.ctrl && ev.key === "f") {
      this.editPath();
      return true;
    }
    if (ev.ctrl && ev.key === ".") {
      const name = this.current()?.name;
      this.showHidden = !this.showHidden;
      this.load(name);
      this.app.toast(this.showHidden ? "\u5DF2\u663E\u793A\u9690\u85CF\u6587\u4EF6" : "\u5DF2\u9690\u85CF\u9690\u85CF\u6587\u4EF6");
      return true;
    }
    if (ev.ctrl && (ev.key === "/" || ev.key === "_")) {
      this.filter = "";
      this.load();
      return true;
    }
    if (ev.name === "escape") {
      this.clearKitty();
      this.onCancel?.();
      return true;
    }
    if (ev.name === "up") {
      this.clearKitty();
      this.sel = wrapIndex(this.sel - 1, this.items().length);
      return true;
    }
    if (ev.name === "down") {
      this.clearKitty();
      this.sel = wrapIndex(this.sel + 1, this.items().length);
      return true;
    }
    if (ev.name === "left") {
      this.goParent();
      return true;
    }
    if (ev.name === "right") {
      this.enterDir();
      return true;
    }
    if (ev.name === "enter") {
      this.confirmUpload();
      return true;
    }
    if (ev.name === "char" && ev.key === " ") {
      this.toggle();
      return true;
    }
    if (ev.name === "char" && ev.key === "/") {
      this.startFilter();
      return true;
    }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") {
      this.sel = wrapIndex(this.sel - 1, this.items().length);
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.sel = wrapIndex(this.sel + 1, this.items().length);
      return true;
    }
    return true;
  }
};

// vendor/dsh-neotui/src/config.js
var import_node_fs5 = require("node:fs");
var import_node_path5 = require("node:path");
var import_node_os3 = require("node:os");

// vendor/dsh-neotui/src/keybindings.js
var KEYBINDING_MODES = ["normal", "insert", "all"];
var DEFAULT_KEYBINDINGS = {
  think: { mode: "normal", key: "t", key2: "" },
  tools: { mode: "normal", key: "b", key2: "" },
  insert: { mode: "normal", key: "i", key2: "" },
  leaveInsert: { mode: "insert", key: "Esc", key2: "" },
  sessionFilter: { mode: "normal", key: "Ctrl+F", key2: "/" },
  newSession: { mode: "normal", key: "n", key2: "" },
  top: { mode: "normal", key: "g g", key2: "" },
  bottom: { mode: "normal", key: "G", key2: "" },
  prevQuestion: { mode: "normal", key: "[", key2: "" },
  nextQuestion: { mode: "normal", key: "]", key2: "" },
  expandInput: { mode: "insert", key: "Ctrl+L", key2: "" },
  copyInput: { mode: "insert", key: "Ctrl+Shift+C", key2: "" },
  panel: { mode: "all", key: "Ctrl+Space", key2: "F7" },
  model: { mode: "normal", key: "Ctrl+M", key2: "" },
  trajectory: { mode: "normal", key: "Ctrl+T", key2: "" },
  homeSwitch: { mode: "normal", key: "Ctrl+Left", key2: "Ctrl+Right" },
  permissionRotate: { mode: "normal", key: "F8", key2: "" },
  workspace: { mode: "normal", key: "Ctrl+W", key2: "" },
  settings: { mode: "normal", key: "Ctrl+S", key2: "" },
  subagent: { mode: "normal", key: "Ctrl+A", key2: "" },
  skills: { mode: "normal", key: "Ctrl+H", key2: "" },
  goal: { mode: "normal", key: "Ctrl+G", key2: "" },
  jobs: { mode: "normal", key: "Ctrl+J", key2: "" },
  queue: { mode: "normal", key: "Ctrl+N", key2: "" },
  busyEnter: { mode: "normal", key: "Ctrl+Y", key2: "" },
  attachments: { mode: "normal", key: "Ctrl+O", key2: "" },
  stepJump: { mode: "normal", key: "Ctrl+E", key2: "" },
  sidebar: { mode: "normal", key: "Ctrl+B", key2: "" },
  editConfig: { mode: "normal", key: "Ctrl+K", key2: "" },
  quit: { mode: "all", key: "Ctrl+Q", key2: "" }
};
var KEYBINDING_ORDER = [
  "sessionFilter",
  "panel",
  "homeSwitch",
  "permissionRotate",
  "editConfig",
  "quit",
  "model",
  "trajectory",
  "workspace",
  "settings",
  "subagent",
  "skills",
  "goal",
  "jobs",
  "queue",
  "busyEnter",
  "attachments",
  "stepJump",
  "sidebar"
];
var CHAT_BINDING_ORDER = ["think", "tools", "insert", "top", "bottom", "prevQuestion", "nextQuestion", "sessionFilter"];
var SIDEBAR_BINDING_ORDER = ["insert", "newSession"];
var NAMED_KEYS = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  enter: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backtab: "backtab",
  pgup: "pgup",
  pgdn: "pgdn",
  home: "home",
  end: "end",
  insert: "insert",
  delete: "delete"
};
function parseKeyPart(part) {
  if (typeof part !== "string") return null;
  const pieces = part.split("+");
  const base = pieces.pop() ?? "";
  if (!base) return null;
  const mods = { ctrl: false, shift: false, alt: false };
  for (const piece of pieces) {
    if (piece === "Ctrl") mods.ctrl = true;
    else if (piece === "Shift") mods.shift = true;
    else if (piece === "Alt") mods.alt = true;
    else return null;
  }
  const named = NAMED_KEYS[base.toLowerCase()];
  if (named) return { ...mods, named };
  if (base === " " || base.toLowerCase() === "space") return { ...mods, space: true };
  if (/^f\d{1,2}$/i.test(base)) return { ...mods, fkey: base.toLowerCase() };
  if (base.length === 1) {
    const lower = base.toLowerCase();
    const wantsShift = base !== lower && !mods.ctrl && !mods.alt;
    return { ...mods, shift: mods.shift || wantsShift, char: lower };
  }
  return null;
}
function specParts(spec) {
  return String(spec ?? "").split(/\s+/).filter(Boolean);
}
function matchKeyPart(ev, part) {
  if (!ev || ev.type !== "key") return false;
  const parsed = parseKeyPart(part);
  if (!parsed) return false;
  const ctrl = ev.ctrl === true, shift = ev.shift === true, alt = ev.alt === true;
  if (ctrl !== parsed.ctrl || alt !== parsed.alt) return false;
  if (parsed.space) return ev.name === "char" && ev.key === " " && shift === parsed.shift;
  if (parsed.named) return ev.name === parsed.named && shift === parsed.shift;
  if (parsed.fkey) return ev.name === parsed.fkey && shift === parsed.shift;
  return ev.name === "char" && ev.key === parsed.char && shift === parsed.shift;
}
function matchKeyBinding(ev, spec, pending = null) {
  if (!spec) return null;
  for (const slot of ["key", "key2"]) {
    const parts = specParts(spec[slot]);
    if (parts.length === 0) continue;
    if (pending && pending.slot === slot) {
      const part = parts[pending.part];
      if (!part || !matchKeyPart(ev, part)) continue;
      return pending.part + 1 >= parts.length ? { kind: "full", slot } : { kind: "pending", slot, part: pending.part + 1 };
    }
    if (parts.length === 1 && matchKeyPart(ev, parts[0])) return { kind: "full", slot };
    if (parts.length === 2 && matchKeyPart(ev, parts[0])) return { kind: "pending", slot, part: 1 };
  }
  return null;
}
function bindingMatchFor(ev, bindings, editing, order = KEYBINDING_ORDER) {
  for (const id of order) {
    const spec = bindings?.[id];
    if (!spec) continue;
    if (spec.mode === "normal" && editing) continue;
    if (spec.mode === "insert" && !editing) continue;
    const hit = matchKeyBinding(ev, spec);
    if (hit?.kind === "full") return { id, slot: hit.slot };
  }
  return null;
}
function describeSpec(spec) {
  const parts = specParts(spec);
  return parts.length ? parts.join(", ") : "\u2014";
}
function validateKeySpec(spec) {
  const parts = specParts(spec);
  if (parts.length === 0 || parts.length > 2) {
    return { ok: false, reason: `\u9700\u8981 1\u20132 \u6B21\u6309\u952E\uFF08\u5982 "Ctrl+F" \u6216 "g g"\uFF09\uFF0C\u5F97\u5230 ${parts.length || 0} \u6B21` };
  }
  for (const part of parts) {
    if (!parseKeyPart(part)) {
      return { ok: false, reason: `\u65E0\u6CD5\u89E3\u6790\u6309\u952E "${part}"\uFF08\u652F\u6301 Ctrl/Shift/Alt \u4FEE\u9970\u3001\u65B9\u5411/\u529F\u80FD\u952E\u3001\u5355\u5B57\u7B26\uFF0C\u5982 Ctrl+Left\u3001F8\u3001g g\uFF09` };
    }
  }
  return { ok: true };
}
function normalizeKeyBinding(value) {
  const mode = KEYBINDING_MODES.includes(value?.mode) ? value.mode : "normal";
  const key = typeof value?.key === "string" ? value.key.trim() : "";
  const key2 = typeof value?.key2 === "string" ? value.key2.trim() : "";
  return { mode, key, key2 };
}

// vendor/dsh-neotui/src/config.js
function tuiConfigFile() {
  return (0, import_node_path5.join)(configRoot(), "tui-config.json");
}
var cache = { file: null, data: null, at: 0 };
function loadTuiConfig() {
  const now = Date.now();
  const file = tuiConfigFile();
  if (cache.file === file && cache.data && now - cache.at < 1e3) return cache.data;
  let data;
  try {
    data = JSON.parse((0, import_node_fs5.readFileSync)(file, "utf8"));
  } catch {
    data = {};
  }
  cache = { file, data, at: now };
  return data;
}
function saveTuiConfig(patch) {
  const file = tuiConfigFile();
  const cfg = { ...loadTuiConfig(), ...patch };
  try {
    (0, import_node_fs5.mkdirSync)((0, import_node_path5.dirname)(file), { recursive: true });
    (0, import_node_fs5.writeFileSync)(file, JSON.stringify(cfg, null, 2) + "\n");
    cache = { file, data: cfg, at: Date.now() };
    return true;
  } catch {
    return false;
  }
}
var OS_USERNAME = null;
function osUsername() {
  if (OS_USERNAME !== null) return OS_USERNAME;
  try {
    OS_USERNAME = (0, import_node_os3.userInfo)().username;
  } catch {
    OS_USERNAME = "";
  }
  return OS_USERNAME;
}
function userName() {
  const cfg = loadTuiConfig();
  return cfg.userPrefix || process.env.DSH_TUI_USER_PREFIX || osUsername() || process.env.USER || process.env.LOGNAME || "user";
}
function userPrefix() {
  return `${userName()} > `;
}
function busyEnter() {
  return loadTuiConfig().busyEnter === "steer" ? "steer" : "queue";
}
var LEGACY_KEY_VALUES = {
  sessionFilter: { mode: "normal", key: "/" },
  homeSwitch: { mode: "normal", key: "Ctrl+Left/Right" },
  skills: { mode: "normal", key: "Ctrl+K" }
};
function keyBindings() {
  const overrides = loadTuiConfig().keyBindings ?? {};
  const merged = {};
  for (const id of Object.keys(DEFAULT_KEYBINDINGS)) {
    const def = DEFAULT_KEYBINDINGS[id];
    const raw = overrides[id];
    if (!raw) {
      merged[id] = { ...def };
      continue;
    }
    const normalized = normalizeKeyBinding(raw);
    const legacy = LEGACY_KEY_VALUES[id];
    if (legacy && !Object.hasOwn(raw, "key2") && normalized.mode === legacy.mode && normalized.key === legacy.key) {
      merged[id] = { ...def };
      continue;
    }
    if (!normalized.key || !validateKeySpec(normalized.key).ok) {
      merged[id] = { ...def };
      continue;
    }
    const key2 = Object.hasOwn(raw, "key2") ? normalized.key2 && validateKeySpec(normalized.key2).ok ? normalized.key2 : "" : def.key2;
    merged[id] = { mode: normalized.mode, key: normalized.key, key2 };
  }
  return merged;
}
function setKeyBinding(id, value) {
  if (!Object.hasOwn(DEFAULT_KEYBINDINGS, id)) return false;
  const normalized = normalizeKeyBinding(value);
  if (!normalized.key || !validateKeySpec(normalized.key).ok) return false;
  if (normalized.key2 && !validateKeySpec(normalized.key2).ok) return false;
  const all = { ...loadTuiConfig().keyBindings ?? {} };
  all[id] = normalized;
  return saveTuiConfig({ keyBindings: all });
}
function resetKeyBinding(id) {
  const all = { ...loadTuiConfig().keyBindings ?? {} };
  delete all[id];
  return saveTuiConfig({ keyBindings: all });
}
function reloadTuiConfig() {
  cache = { file: null, data: null, at: 0 };
}
function foldDefaults() {
  const fd = loadTuiConfig().foldDefaults ?? {};
  return {
    think: fd.think !== false,
    // think blocks default expanded
    bash: fd.bash === true,
    // tool blocks default collapsed
    todos: fd.todos !== false
    // todo list default visible
  };
}

// vendor/dsh-neotui/src/panels.js
var import_node_fs6 = require("node:fs");
var import_node_os4 = require("node:os");
var import_node_path6 = require("node:path");
var import_node_child_process3 = require("node:child_process");
var K = new Proxy({}, { get(_k, key) {
  return T[key];
} });
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 1e3 + (1e3 - t.indexOf(q)) - t.length / 10;
  let qi = 0, score = 0, streak = 0, firstHit = true;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10 + streak * 6 + (firstHit ? 5 : 0) + (ti === 0 || /[\s\-_/.]/.test(t[ti - 1]) ? 8 : 0);
      streak++;
      qi++;
      firstHit = false;
    } else {
      streak = 0;
      score -= 0.5;
    }
  }
  return qi === q.length ? score : -1;
}
var Picker = class extends Widget {
  constructor({ x, y, w, h, title, items, onPick, onCancel, placeholder = "\u8F93\u5165\u4EE5\u7B5B\u9009\u2026" }) {
    super({ x, y, w, h });
    this.title = title;
    this.items = items;
    this.onPick = onPick;
    this.onCancel = onCancel;
    this.placeholder = placeholder;
    this.query = "";
    this.sel = 0;
    this.scroll = 0;
    this.input = new Input({ x: x + 1, y: y + 1, w: w - 2, h: 1, prompt: "\u276F ", placeholder, bg: T.BG2 });
  }
  filtered() {
    const scored = this.items.map((it) => ({ it, s: fuzzyScore(this.query, `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""}`) })).filter((e) => e.s > 0 || this.query === "").sort((a, b) => b.s - a.s).map((e) => e.it);
    if (this.sel >= scored.length) this.sel = Math.max(0, scored.length - 1);
    return scored;
  }
  render(screen) {
    if (this.input.value !== this.query) this.input.setValue(this.query);
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: K.ACCENT, bg: T.BG2 }, this.title);
    this.input.render(screen);
    const list = this.filtered();
    const lh = this.h - 3;
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + lh) this.scroll = this.sel - lh + 1;
    for (let i = 0; i < lh; i++) {
      const idx = this.scroll + i;
      const it = list[idx];
      const y = this.y + 2 + i;
      if (!it) {
        screen.hline(this.x + 1, this.x + this.w - 2, y, " ", { bg: T.BG2 });
        continue;
      }
      const sel = idx === this.sel;
      screen.fillRect(this.x + 1, y, this.x + this.w - 2, y, " ", { bg: sel ? T.MENUSEL : T.BG2 });
      const hint = it.hint ? "  " + it.hint : "";
      screen.text(this.x + 2, y, truncate(it.label, this.w - 4 - strWidth(hint)), { fg: sel ? 16777215 : K.TXT, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 });
      if (it.hint) screen.text(this.x + this.w - 2 - strWidth(hint), y, hint, { fg: K.DIM, bg: sel ? T.MENUSEL : T.BG2 });
    }
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.scroll + (ev.y - this.y - 2);
      const list = this.filtered();
      if (ev.y === this.y + 1) {
        this.input.onMouse(ev);
        return true;
      }
      if (idx >= 0 && idx < list.length) {
        this.onPick?.(list[idx]);
        return true;
      }
      return true;
    }
    if (ev.kind === "wheel-up") {
      this.sel = wrapIndex(this.sel - 1, this.filtered().length);
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.sel = wrapIndex(this.sel + 1, this.filtered().length);
      return true;
    }
    return true;
  }
  onKey(ev) {
    if (ev.type === "text") {
      this.query += ev.text;
      this.sel = 0;
      return true;
    }
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up":
        this.sel = wrapIndex(this.sel - 1, this.filtered().length);
        return true;
      case "down":
        this.sel = wrapIndex(this.sel + 1, this.filtered().length);
        return true;
      case "enter": {
        const l = this.filtered();
        if (l[this.sel]) {
          this.onPick?.(l[this.sel]);
        }
        return true;
      }
      case "escape":
        this.onCancel?.();
        return true;
      case "backspace":
        this.query = this.query.slice(0, -1);
        this.sel = 0;
        return true;
      case "char":
        if (!ev.ctrl) {
          this.query += ev.text;
          this.sel = 0;
          return true;
        }
        return false;
    }
    return false;
  }
};
var ModelPickerBuffer = class extends Widget {
  constructor(app) {
    const w = Math.max(1, Math.min(88, app.screen.w - 4)), h = Math.max(1, Math.min(28, app.screen.h - 4));
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.title = "\u9009\u62E9\u6A21\u578B";
    this.query = "";
    this.filtering = false;
    this.sel = 0;
    this.scroll = 0;
    this.collapsed = /* @__PURE__ */ new Set();
    this.items = [];
    this.rows = [];
    this.loading = false;
    this.manageRow = { kind: "manage" };
    this.input = new Input({ x: this.x + 1, y: this.y + 1, w: this.w - 2, h: 1, prompt: "\u276F ", placeholder: "\u8F93\u5165\u4EE5\u7B5B\u9009\u6A21\u578B\u2026", bg: T.BG2 });
    this.#load();
  }
  async #load() {
    this.loading = true;
    try {
      const { groups } = await this.app.api.call("llm.models");
      this.items = (groups ?? []).map((g) => ({
        provider: g.id,
        name: g.name ?? g.id,
        models: (g.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, description: m.description ?? "", efforts: m.reasoning?.efforts ?? [], defaultEffort: m.reasoning?.defaultEffort, provider: g.id }))
      }));
      const cur = this.app.currentModel;
      this.collapsed = new Set(this.items.map((g) => g.provider).filter((p) => p !== cur?.provider));
      this.#rebuildRows();
      const idx = this.rows.findIndex((r) => r.kind === "model" && r.model.provider === cur?.provider && r.model.id === cur?.model);
      this.sel = idx >= 0 ? idx : 0;
    } catch (e) {
      this.app.toast?.(`\u6A21\u578B\u5217\u8868\u5931\u8D25: ${e.message}`);
    }
    this.loading = false;
    this.#clampScroll();
    this.app.redraw?.();
  }
  filteredMatches() {
    if (!this.query) return null;
    const q = this.query.toLowerCase();
    return this.items.flatMap((g) => g.models.filter((m) => fuzzyScore(q, `${m.id} ${m.name} ${m.description}`) > 0).map((model) => ({ group: g, model })));
  }
  #rebuildRows() {
    const rows = [];
    const filtered = this.filteredMatches();
    if (filtered) {
      const byProvider = /* @__PURE__ */ new Map();
      for (const { group, model } of filtered) {
        if (!byProvider.has(group.provider)) byProvider.set(group.provider, []);
        byProvider.get(group.provider).push(model);
      }
      for (const group of this.items) {
        const models = byProvider.get(group.provider);
        if (!models) continue;
        rows.push({ kind: "provider", group, count: models.length });
        for (const model of models) rows.push({ kind: "model", group, model });
      }
    } else {
      for (const group of this.items) {
        const open = !this.collapsed.has(group.provider);
        rows.push({ kind: "provider", group, count: group.models.length });
        if (open) for (const model of group.models) rows.push({ kind: "model", group, model });
      }
      rows.push(this.manageRow);
    }
    this.rows = rows;
    if (this.sel >= rows.length) this.sel = Math.max(0, rows.length - 1);
  }
  #clampScroll() {
    const lh = Math.max(1, this.h - 3);
    if (this.sel < this.scroll) this.scroll = this.sel;
    else if (this.sel >= this.scroll + lh) this.scroll = this.sel - lh + 1;
    this.scroll = Math.max(0, this.scroll);
  }
  #toggleGroup(provider) {
    if (this.query) return;
    if (this.collapsed.has(provider)) this.collapsed.delete(provider);
    else this.collapsed.add(provider);
    this.#rebuildRows();
    const idx = this.rows.findIndex((r) => r.kind === "provider" && r.group.provider === provider);
    if (idx >= 0) this.sel = idx;
    this.#clampScroll();
    this.app.redraw?.();
  }
  async #selectModel(entry) {
    const it = { provider: entry.model.provider, model: entry.model.id, efforts: entry.model.efforts, defaultEffort: entry.model.defaultEffort };
    const efforts = it.efforts ?? [];
    if (efforts.length > 0) {
      const w2 = Math.max(1, Math.min(60, this.app.screen.w - 4)), h2 = Math.max(1, Math.min(efforts.length + 4, this.app.screen.h - 4));
      this.app.overlay = new Picker({
        x: Math.floor((this.app.screen.w - w2) / 2),
        y: Math.floor((this.app.screen.h - h2) / 2),
        w: w2,
        h: h2,
        title: `\u601D\u8003\u5F3A\u5EA6 \u2014 ${it.model}`,
        items: efforts.map((e) => ({ label: e.name ?? e.id, hint: e.id === it.defaultEffort ? "\u9ED8\u8BA4" : (e.description ?? "").slice(0, 28), provider: it.provider, model: it.model, effort: e.id })),
        onCancel: () => {
          this.app.overlay = this;
          this.app.redraw();
        },
        onPick: (eff) => this.#commitModel({ provider: eff.provider, model: eff.model, effort: eff.effort })
      });
      this.app.redraw();
      return;
    }
    await this.#commitModel(it);
  }
  async #commitModel(it) {
    this.app.overlay = null;
    this.app.redraw?.();
    if (!this.app.currentSession) {
      this.app.toast?.("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    try {
      await this.app.api.call("session.selectModel", { sessionId: this.app.currentSession, provider: it.provider, model: it.model, ...it.effort ? { reasoningEffort: it.effort } : {} });
      this.app.updateModel?.();
      this.app.toast?.(`\u5DF2\u5207\u6362 ${it.provider}/${it.model}${it.effort ? ` (${it.effort})` : ""}`);
    } catch (e) {
      this.app.toast?.(`\u5207\u6362\u5931\u8D25: ${e.message}`);
    }
  }
  #activate() {
    const row = this.rows[this.sel];
    if (!row) return;
    if (row.kind === "manage") {
      this.app.overlay = null;
      typeof this.app.showModelsBuffer === "function" ? this.app.showModelsBuffer() : this.app.setMode?.("models");
      return;
    }
    if (row.kind === "provider") {
      this.#toggleGroup(row.group.provider);
      return;
    }
    if (row.kind === "model") void this.#selectModel(row);
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    screen.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: K.ACCENT, bg: T.BG2 }, this.w >= 44 ? " \u9009\u62E9\u6A21\u578B \xB7 / \u7B5B\u9009 \xB7 Ctrl+/ \u9000\u51FA \xB7 Space \u5C55\u5F00 \xB7 Enter \u786E\u8BA4 " : " \u9009\u62E9\u6A21\u578B ");
    this.input.prompt = this.filtering ? "/ " : "\u276F ";
    this.input.setValue(this.filtering ? this.query : "");
    this.input.render(screen);
    const lh = Math.max(1, this.h - 3);
    this.#clampScroll();
    for (let i = 0; i < lh; i++) {
      const idx = this.scroll + i;
      const row = this.rows[idx];
      const y = this.y + 2 + i;
      if (!row) {
        screen.hline(this.x + 1, this.x + this.w - 2, y, " ", { bg: T.BG2 });
        continue;
      }
      const sel = idx === this.sel;
      const cur = this.app.currentModel;
      screen.fillRect(this.x + 1, y, this.x + this.w - 2, y, " ", { bg: sel ? T.MENUSEL : T.BG2 });
      const style = { fg: sel ? 16777215 : K.TXT, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 };
      let text;
      if (row.kind === "manage") text = "\u2699 \u7BA1\u7406\u4F9B\u5E94\u5546\u2026";
      else if (row.kind === "provider") {
        const open = this.query ? true : !this.collapsed.has(row.group.provider);
        text = `${open ? "\u25BE" : "\u25B8"} \u{1F4C1} ${row.group.name} (${row.count})`;
      } else {
        const mark = cur?.provider === row.model.provider && cur?.model === row.model.id ? "\u25CF" : "\u25CB";
        text = `    ${mark} ${row.model.id}${row.model.name !== row.model.id ? `  ${row.model.name}` : ""}`;
      }
      screen.text(this.x + 2, y, truncate(text, this.w - 4), row.kind === "provider" ? { fg: K.ACCENT, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 } : style);
    }
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      if (ev.y === this.y + 1) {
        this.input.onMouse(ev);
        return true;
      }
      const idx = this.scroll + (ev.y - this.y - 2);
      if (idx >= 0 && idx < this.rows.length) {
        this.sel = idx;
        this.#activate();
      }
      return true;
    }
    if (ev.kind === "wheel-up") {
      this.sel = wrapIndex(this.sel - 1, this.rows.length);
      this.#clampScroll();
      this.app.redraw?.();
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.sel = wrapIndex(this.sel + 1, this.rows.length);
      this.#clampScroll();
      this.app.redraw?.();
      return true;
    }
    return true;
  }
  onKey(ev) {
    if (ev.type === "text") {
      if (this.filtering) {
        this.query += ev.text;
        this.sel = 0;
        this.#rebuildRows();
        this.app.redraw?.();
        return true;
      }
      if (ev.text === "/") {
        this.filtering = true;
        this.query = "";
        this.#rebuildRows();
        this.app.redraw?.();
        return true;
      }
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.ctrl && ev.name === "char" && ev.key === "/") {
      this.filtering = false;
      this.query = "";
      this.#rebuildRows();
      this.app.redraw?.();
      return true;
    }
    switch (ev.name) {
      case "up":
        this.sel = wrapIndex(this.sel - 1, this.rows.length);
        this.#clampScroll();
        this.app.redraw?.();
        return true;
      case "down":
        this.sel = wrapIndex(this.sel + 1, this.rows.length);
        this.#clampScroll();
        this.app.redraw?.();
        return true;
      case "pgup":
        this.scroll = Math.max(0, this.scroll - Math.max(1, this.h - 3));
        return true;
      case "pgdn":
        this.scroll = this.scroll + Math.max(1, this.h - 3);
        return true;
      case "enter":
        this.#activate();
        return true;
      case "escape":
        if (this.filtering) {
          this.filtering = false;
          this.query = "";
          this.#rebuildRows();
          this.app.redraw?.();
          return true;
        }
        this.app.overlay = null;
        this.app.redraw?.();
        return true;
      case "backspace":
        if (!this.filtering) return true;
        this.query = this.query.slice(0, -1);
        this.sel = 0;
        this.#rebuildRows();
        this.app.redraw?.();
        return true;
      case "char":
        if (ev.key === " " && !ev.ctrl) {
          const row = this.rows[this.sel];
          if (row?.kind === "provider") this.#toggleGroup(row.group.provider);
          else if (row?.kind === "model") this.#toggleGroup(row.group.provider);
          return true;
        }
        if (!ev.ctrl) {
          if (ev.key === "/") {
            this.filtering = true;
            this.query = "";
            this.sel = 0;
            this.#rebuildRows();
            this.app.redraw?.();
            return true;
          }
          if (this.filtering) {
            this.query += ev.text ?? ev.key;
            this.sel = 0;
            this.#rebuildRows();
            this.app.redraw?.();
          }
          return true;
        }
        return false;
    }
    return false;
  }
};
function buildModelPicker(app) {
  return new ModelPickerBuffer(app);
}
var MODE_NAMES = { standard: "\u6807\u51C6\u6A21\u5F0F", code: "PTC \u6A21\u5F0F", minimal: "\u6781\u7B80\u6A21\u5F0F", cordis: "\u521B\u9020\u6A21\u5F0F" };
var PERM_NAMES = { "read-only": "\u53EA\u8BFB", "workspace-write": "\u5DE5\u4F5C\u533A\u5199\u5165", "danger-full-access": "\u5B8C\u5168\u8BBF\u95EE" };
function modeName(id) {
  return MODE_NAMES[id] ?? id;
}
function permName(id) {
  return PERM_NAMES[id] ?? id;
}
function buildModePicker(app) {
  const w = Math.max(1, Math.min(66, app.screen.w - 4)), h = Math.max(1, Math.min(18, app.screen.h - 4));
  const picker = new Picker({
    x: Math.floor((app.screen.w - w) / 2),
    y: Math.floor((app.screen.h - h) / 2),
    w,
    h,
    title: "\u6A21\u5F0F\uFF08Agent \u9884\u8BBE\uFF09",
    items: [],
    onCancel: () => {
      app.overlay = null;
      app.redraw();
    },
    onPick: (it) => {
      app.overlay = null;
      app.redraw();
      app.selectPreset(it.id);
    }
  });
  app.api.call("agentPreset.list").then(({ presets }) => {
    const cur = app.sessions.find((s) => s.sessionId === app.currentSession)?.agentPreset;
    picker.items = presets.filter((p) => !p.broken).map((p) => ({
      label: `${p.id === cur ? "\u25CF" : p.isDefault ? "\u25D0" : "\u25CB"} ${modeName(p.id)}`,
      hint: p.id === cur ? "\u5F53\u524D" : p.isDefault ? "\u9ED8\u8BA4" : p.id,
      id: p.id,
      keywords: `${p.id} ${p.description ?? ""}`
    }));
    app.redraw();
  }).catch((e) => app.toast(`\u6A21\u5F0F\u5217\u8868\u5931\u8D25: ${e.message}`));
  return picker;
}
function buildPermissionPicker(app) {
  const perms = app.projections.permissions;
  const options = (perms?.options ?? []).filter((o) => o.value !== "custom");
  const current2 = perms?.currentValue;
  const w = Math.max(1, Math.min(60, app.screen.w - 4)), h = Math.max(1, Math.min(options.length + 4, 16, app.screen.h - 4));
  return new Picker({
    x: Math.floor((app.screen.w - w) / 2),
    y: Math.floor((app.screen.h - h) / 2),
    w,
    h,
    title: "\u6743\u9650\uFF08\u6C99\u7BB1 + \u5BA1\u6279\uFF09",
    items: options.map((o) => ({
      label: `${o.value === current2 ? "\u25CF" : "\u25CB"} ${permName(o.value)}`,
      hint: o.value === current2 ? "\u5F53\u524D" : o.value,
      value: o.value,
      keywords: o.value
    })),
    onCancel: () => {
      app.overlay = null;
      app.redraw();
    },
    onPick: (it) => {
      app.overlay = null;
      app.redraw();
      app.switchPermission(it.value);
    }
  });
}
var WorkspacePanel = class extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.workspaces = [];
    this.tree = [];
    this.treeScroll = new ScrollView({ x: this.x + 1, y: this.y + 1, w: Math.floor(this.w / 2), h: this.h - 2, showScrollbar: true });
    this.preview = new ScrollView({ x: this.x + Math.floor(this.w / 2) + 1, y: this.y + 1, w: this.w - Math.floor(this.w / 2) - 2, h: this.h - 2, showScrollbar: true });
    this.previewPath = null;
    this.query = "";
    this.searchSel = 0;
    this.searchResults = [];
    this.searchScroll = 0;
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    const half = Math.floor(w / 2);
    this.treeScroll.x = x + 1;
    this.treeScroll.y = y + 1;
    this.treeScroll.w = half;
    this.treeScroll.h = h - 2;
    this.preview.x = x + half + 1;
    this.preview.y = y + 1;
    this.preview.w = w - half - 2;
    this.preview.h = h - 2;
  }
  async load() {
    this.query = "";
    this.searchSel = 0;
    this.searchResults = [];
    try {
      const { items } = await this.app.api.call("workspace.list");
      this.workspaces = items;
      const tree = [];
      for (const ws of items) {
        tree.push({ depth: 0, name: `\u25A3 ${ws.title}`, title: ws.title, path: ws.path, isDir: true, open: false, ws: true, workspaceId: ws.workspaceId });
      }
      this.tree = tree;
      this.rebuildTree();
    } catch (e) {
      this.app.toast(`\u5DE5\u4F5C\u533A\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
    }
  }
  expand(node) {
    node.open = !node.open;
    this.rebuildTree();
  }
  rebuildTree() {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        out.push(n);
        if (n.isDir && n.open && n.children) walk(n.children);
      }
    };
    walk(this.tree);
    this.treeLines = out.map((n) => {
      const indent = "  ".repeat(n.depth);
      const icon = n.isDir ? n.open ? "\u25BE" : "\u25B8" : "\xB7";
      const segs = [{ t: `${indent}${icon} ${n.name}`, fg: n.isDir ? K.ACCENT : K.TXT, bold: n.ws }];
      return segs;
    });
    this.treeScroll.setLines(this.treeLines);
    this.app.redraw();
  }
  async fillChildren(node) {
    try {
      const entries = (0, import_node_fs6.readdirSync)(node.path, { withFileTypes: true }).filter((d) => !d.name.startsWith(".") && d.name !== "node_modules").sort((a, b) => a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1);
      node.children = entries.map((d) => ({
        depth: node.depth + 1,
        name: d.name,
        path: (0, import_node_path6.join)(node.path, d.name),
        isDir: d.isDirectory(),
        open: false,
        children: d.isDirectory() ? [] : null
      }));
    } catch {
      node.children = [];
    }
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 2) {
      const idx = this.treeScroll.scrollY + (ev.y - this.treeScroll.y);
      const node = this.treeLinesNode(idx);
      if (node?.ws) {
        this.app.openMenu([
          { label: "\u6DFB\u52A0\u5DE5\u4F5C\u533A\u2026", action: () => this.app.addWorkspace() },
          { label: "\u91CD\u547D\u540D\u5DE5\u4F5C\u533A", action: () => this.app.renameWorkspace(node) },
          { label: "\u4E0A\u79FB\u5DE5\u4F5C\u533A", action: () => this.app.moveWorkspace(node, -1) },
          { label: "\u4E0B\u79FB\u5DE5\u4F5C\u533A", action: () => this.app.moveWorkspace(node, 1) }
        ], ev);
      } else {
        this.app.openMenu([
          { label: "\u6DFB\u52A0\u5DE5\u4F5C\u533A\u2026", action: () => this.app.addWorkspace() }
        ], ev);
      }
      return true;
    }
    if (ev.x >= this.x + 1 && ev.x < this.x + Math.floor(this.w / 2)) {
      const idx = this.treeScroll.scrollY + (ev.y - this.treeScroll.y);
      const node = this.treeLinesNode(idx);
      if (node) {
        if (ev.kind === "press" && ev.button === 0) {
          if (node.isDir) {
            if (!node.open && (!node.children || node.children.length === 0)) {
              this.fillChildren(node);
            }
            this.expand(node);
          } else if (!node.ws) this.previewFile(node.path);
          return true;
        }
        if (ev.kind === "wheel-up" || ev.kind === "wheel-down") return this.treeScroll.onMouse(ev);
      }
      return false;
    }
    return this.preview.onMouse(ev);
  }
  treeLinesNode(idx) {
    let i = 0;
    const find = (nodes) => {
      for (const n of nodes) {
        if (i === idx) return n;
        i++;
        if (n.isDir && n.open && n.children) {
          const r = find(n.children);
          if (r) return r;
        }
      }
      return null;
    };
    return find(this.tree);
  }
  previewFile(path) {
    this.previewPath = path;
    try {
      const st = (0, import_node_fs6.statSync)(path);
      if (st.size > 256 * 1024) {
        this.preview.setLines([[{ t: `\u6587\u4EF6\u8FC7\u5927\uFF08${Math.round(st.size / 1024)}KB\uFF09\uFF0C\u4EC5\u9884\u89C8\u524D 256KB`, fg: K.WARN }]]);
        return;
      }
      const text = (0, import_node_fs6.readFileSync)(path, "utf8");
      const lang = (0, import_node_path6.extname)(path).slice(1);
      const lines = [];
      lines.push([{ t: (0, import_node_path6.basename)(path), fg: K.ACCENT, bold: true, underline: true }]);
      lines.push([{ t: "" }]);
      const codeLines = text.split("\n").slice(0, 300);
      let inFence = false;
      for (const cl of codeLines) {
        if (cl.trim().startsWith("```")) {
          inFence = !inFence;
          lines.push([{ t: cl, fg: K.FAINT }]);
          continue;
        }
        if (inFence) lines.push([{ t: truncate(cl, this.preview.w - 2), fg: K.DIM, code: true }]);
        else lines.push([{ t: truncate(cl, this.preview.w - 2), fg: K.TXT }]);
      }
      this.preview.setLines(lines);
      this.app.redraw();
    } catch (e) {
      this.preview.setLines([[{ t: `\u8BFB\u53D6\u5931\u8D25: ${e.message}`, fg: K.ERR }]]);
    }
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    const mid = this.x + Math.floor(this.w / 2);
    screen.put(mid, this.y, "\u252C", { fg: T.BORDER, bg: T.BG2 });
    screen.vline(mid, this.y + 1, this.y + this.h - 1);
    screen.text(this.x + 1, this.y, ` \u5DE5\u4F5C\u533A (${this.workspaces.length}) \u2014 \u70B9\u51FB\u76EE\u5F55\u5C55\u5F00\uFF0C/ \u641C\u7D22\u6587\u4EF6\uFF0C\u53F3\u952E\u6DFB\u52A0\u5DE5\u4F5C\u533A`, { fg: K.DIM, bg: T.BG2 });
    if (this.query) {
      const results = [];
      const walk = (nodes) => {
        for (const n of nodes) {
          if (!n.ws && !n.isDir && n.name.toLowerCase().includes(this.query.toLowerCase())) results.push(n.path);
          if (n.children) walk(n.children);
        }
      };
      walk(this.tree);
      this.searchResults = results;
      const visH = Math.max(1, this.h - 2);
      if (this.searchSel < (this.searchScroll ?? 0)) this.searchScroll = this.searchSel;
      else if (this.searchSel >= (this.searchScroll ?? 0) + visH) this.searchScroll = this.searchSel - visH + 1;
      this.searchScroll = Math.max(0, Math.min(Math.max(0, results.length - visH), this.searchScroll ?? 0));
      for (let i = 0; i < visH; i++) {
        const idx = this.searchScroll + i;
        if (idx >= results.length) break;
        const sel = idx === this.searchSel;
        screen.fillRect(this.x + 1, this.y + 2 + i, mid - 2, this.y + 2 + i, " ", { bg: sel ? K.MENUSEL : -1 });
        screen.text(this.x + 2, this.y + 2 + i, truncate("\u26B2 " + (0, import_node_path6.basename)(results[idx]), mid - 6), { fg: sel ? K.BOLD : K.TXT, bg: sel ? K.MENUSEL : -1 });
      }
      screen.text(this.x + 1, this.y + this.h - 1, ` \u5339\u914D ${results.length} \u4E2A\u6587\u4EF6 \xB7 Esc \u9000\u51FA\u641C\u7D22`, { fg: K.FAINT });
      return;
    }
    this.treeScroll.render(screen);
    this.preview.render(screen);
  }
  onKey(ev) {
    if (ev.type === "text") {
      this.query += ev.text;
      this.searchSel = 0;
      this.app.redraw();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      if (this.query) {
        this.query = "";
        this.app.redraw();
        return true;
      }
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
      return true;
    }
    if (ev.name === "backspace") {
      this.query = this.query.slice(0, -1);
      this.app.redraw();
      return true;
    }
    if (ev.name === "down" && this.query) {
      this.searchSel = wrapIndex((this.searchSel ?? 0) + 1, this.searchResults?.length ?? 0);
      this.app.redraw();
      return true;
    }
    if (ev.name === "up" && this.query) {
      this.searchSel = wrapIndex((this.searchSel ?? 0) - 1, this.searchResults?.length ?? 0);
      this.app.redraw();
      return true;
    }
    if (ev.name === "enter" && this.query && this.searchResults?.length) {
      this.previewFile(this.searchResults[this.searchSel ?? 0]);
      return true;
    }
    if (ev.name === "up" || ev.name === "down" || ev.name === "pgup" || ev.name === "pgdn") return this.treeScroll.onKey?.(ev) ?? false;
    return false;
  }
};
var AttachmentPanel = class extends Widget {
  constructor(app) {
    const w = Math.min(76, app.screen.w - 4), h = Math.min(22, app.screen.h - 4);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.sel = 0;
    this.dArmed = false;
  }
  items() {
    return this.app.chat?.attachments ?? [];
  }
  close() {
    this.app.overlay = null;
    this.app.focus(this.app.chat.input);
    this.app.chat.inputChanged();
    this.app.redraw();
  }
  openItem(external = false) {
    const a = this.items()[this.sel];
    if (!a) return;
    if (external) {
      if (!a.path) {
        this.app.toast("\u8FD9\u4E0D\u662F\u672C\u5730\u6587\u4EF6\uFF0C\u65E0\u6CD5\u7528\u9ED8\u8BA4\u7A0B\u5E8F\u5B9A\u4F4D");
        return;
      }
      try {
        openExternal(a.path);
      } catch (e) {
        this.app.toast(`\u6253\u5F00\u5931\u8D25: ${e.message}`);
      }
      return;
    }
    if (a.mediaType?.startsWith("image/")) this.app.openImage(a, { all: this.items(), index: this.sel, returnTo: this });
    else this.app.toast(a.path ? `\u6587\u4EF6: ${a.path}` : "\u8FD9\u4E0D\u662F\u672C\u5730\u6587\u4EF6");
  }
  remove() {
    const a = this.items()[this.sel];
    if (!a) return;
    this.app.chat.attachments.splice(this.sel, 1);
    this.app.chat.clipboardImages = this.app.chat.clipboardImages.filter((x) => x.id !== a.id);
    this.sel = Math.max(0, Math.min(this.sel, this.items().length - 1));
    this.app.chat.inputChanged();
    this.app.redraw();
  }
  render(s) {
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.BG2 });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: K.ACCENT, bg: T.BG2 }, "\u9644\u4EF6\u7BA1\u7406\u5668");
    const items = this.items();
    for (let i = 0; i < Math.min(items.length, this.h - 3); i++) {
      const a = items[i], on = i === this.sel, y = this.y + 1 + i;
      s.fillRect(this.x + 1, y, this.x + this.w - 2, y, " ", { bg: on ? T.MENUSEL : T.BG2 });
      s.text(this.x + 2, y, truncate(`${a.mediaType?.startsWith("image/") ? "\u{F02E9}" : "\u{F0214}"} ${a.name}`, this.w - 6), { fg: on ? T.SELFG : K.TXT, bg: on ? T.MENUSEL : T.BG2 });
    }
    if (!items.length) s.text(this.x + 2, this.y + 2, "\u6682\u65E0\u9644\u4EF6", { fg: K.FAINT, bg: T.BG2 });
    s.text(this.x + 2, this.y + this.h - 1, "Enter \u67E5\u770B \xB7 Shift+Enter/\u53CC\u51FB \u9ED8\u8BA4\u7A0B\u5E8F \xB7 dd \u79FB\u9664 \xB7 Esc \u9000\u51FA", { fg: K.FAINT, bg: T.BG2 });
  }
  onKey(ev) {
    const ch = ev.type === "text" ? ev.text : ev.type === "key" && ev.name === "char" ? ev.key : null;
    if (ch === "d") {
      if (this.dArmed) {
        this.dArmed = false;
        this.remove();
      } else {
        this.dArmed = true;
        this.app.toast("\u518D\u6309 d \u5220\u9664\u9644\u4EF6");
      }
      return true;
    }
    if (ev.type !== "key") {
      this.dArmed = false;
      return false;
    }
    if (ev.name === "escape") {
      this.close();
      return true;
    }
    if (ev.name === "up" || ev.name === "char" && ev.key === "k") {
      this.dArmed = false;
      this.sel = wrapIndex(this.sel - 1, this.items().length);
      return true;
    }
    if (ev.name === "down" || ev.name === "char" && ev.key === "j") {
      this.dArmed = false;
      this.sel = wrapIndex(this.sel + 1, this.items().length);
      return true;
    }
    if (ev.name === "enter") {
      this.dArmed = false;
      this.openItem(!!ev.shift);
      return true;
    }
    this.dArmed = false;
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const i = ev.y - this.y - 1;
      if (i >= 0 && i < this.items().length) {
        const now = Date.now();
        this.sel = i;
        if (this.lastClick && now - this.lastClick < 400) this.openItem(true);
        this.lastClick = now;
      }
      return true;
    }
    return false;
  }
};
var TrajectoryPanel = class extends Widget {
  constructor(app) {
    super({ x: 30, y: 1, w: app.screen.w - 30, h: app.screen.h - 2 });
    this.app = app;
    this.steps = [];
    this.stats = null;
    this.loading = false;
    this.loadingOlder = false;
    this.hasMore = false;
    this.minSeq = null;
    this.allEvents = [];
    this.sessionId = null;
    this.expandedSteps = /* @__PURE__ */ new Set();
    this.selectedStepKey = null;
    this.visibleStepIndices = [];
    this.flashKey = null;
    this.flashUntil = 0;
    this.loadPromise = null;
    this.loadTarget = null;
    this.liveTickAt = 0;
    this.tailFetchAt = 0;
    this.refreshing = false;
    this.winSeqLo = null;
    this.winSeqHi = null;
    this.view = new ScrollView({ x: this.x, y: this.y, w: this.w, h: this.h, showScrollbar: true, onClick: (y) => this.#clickLine(y) });
    this.stepLines = [];
    this.query = "";
  }
  /** Total step count from the session stats (falls back to the newest loaded). */
  totalSteps() {
    return this.stats?.steps ?? (this.steps[this.steps.length - 1]?.step ?? this.steps.length);
  }
  /** LEFT click: toggle the step under the cursor; the "▲ 更早步骤" row loads
   *  one more window-width upward. */
  #clickLine(y) {
    if (this.hasMore && y === 1) {
      this.extendUp();
      return true;
    }
    const si = this.stepLines[y];
    if (si !== void 0) {
      this.#toggleStep(si);
      return true;
    }
    return false;
  }
  #eventSummary(e) {
    const d = e.data ?? {};
    if (e.type === "user/message") return `\u276F ${String(d.content?.[0]?.text ?? "").slice(0, 40)}`;
    if (e.type === "tool/call") return `\u2699 ${d.name ?? "tool"} ${String(d.arguments ?? "").slice(0, 30)}`;
    if (e.type === "tool/result") return "\u21B3 \u7ED3\u679C";
    if (e.type === "assistant/message") return `\u25C9 ${String(d.message?.content?.find((c) => c.type === "text")?.text ?? "").slice(0, 40)}`;
    if (e.type === "assistant/chunk") {
      const ch = d.chunk ?? {};
      return ch.type === "text-delta" ? String(ch.delta ?? "").slice(0, 40) : `[${ch.blockType ?? ch.type}]`;
    }
    return e.type;
  }
  #selectedIndex() {
    if (this.steps.length === 0) return -1;
    let index = this.steps.findIndex((step) => this.stepKey(step) === this.selectedStepKey);
    if (index < 0) {
      index = this.visibleStepIndices[0] ?? this.steps.length - 1;
      this.selectedStepKey = this.stepKey(this.steps[index]);
    }
    return index;
  }
  #moveSelection(delta) {
    if (this.visibleStepIndices.length === 0) return false;
    const current2 = this.#selectedIndex();
    let pos = this.visibleStepIndices.indexOf(current2);
    if (pos < 0) pos = this.visibleStepIndices.length - 1;
    const index = this.visibleStepIndices[wrapIndex(pos + delta, this.visibleStepIndices.length)];
    this.selectedStepKey = this.stepKey(this.steps[index]);
    const line = this.stepLines.indexOf(index);
    if (line < this.view.scrollY) this.view.scrollY = line;
    else if (line >= this.view.scrollY + this.view.h) this.view.scrollY = Math.max(0, line - this.view.h + 1);
    this.buildLines();
    this.app.redraw();
    return true;
  }
  #menuItems(si) {
    const step = this.steps[si];
    const key = step ? this.stepKey(step) : null;
    const currentIndex = () => this.steps.findIndex((candidate) => this.stepKey(candidate) === key);
    const open = step && this.expandedSteps.has(key);
    return step ? [
      { label: open ? "\u6298\u53E0\uFF08\u7B80\u7565\uFF09" : "\u5C55\u5F00\uFF08\u8BE6\u7EC6\uFF09", action: () => {
        const index = currentIndex();
        if (index >= 0) this.#toggleStep(index);
      } },
      { label: "\u8F6C\u8DF3\u5BF9\u8BDD", action: () => {
        const index = currentIndex();
        if (index >= 0) this.app.jumpToChatStep(index);
      } }
    ] : [];
  }
  openSelectedMenu() {
    const si = this.#selectedIndex();
    if (si < 0) return false;
    const line = this.stepLines.indexOf(si);
    this.app.openMenu(this.#menuItems(si), { x: this.view.x + 4, y: this.view.y + Math.max(0, line - this.view.scrollY) });
    return true;
  }
  #toggleStep(si) {
    const step = this.steps[si];
    if (!step) return;
    const key = this.stepKey(step);
    const headerLine = this.stepLines.indexOf(si);
    const topRow = headerLine >= 0 ? headerLine - this.view.scrollY : null;
    if (this.expandedSteps.has(key)) this.expandedSteps.delete(key);
    else this.expandedSteps.add(key);
    this.buildLines();
    if (topRow !== null) {
      const li2 = this.stepLines.indexOf(si);
      if (li2 >= 0) this.view.scrollY = Math.max(0, Math.min(li2 - topRow, this.view.maxScroll()));
    }
    this.app.redraw();
  }
  /** Stable identity across prepends: prefer the step/turn start sequence.
   *  A history page may begin in the middle of a step; its leading fragment
   *  then merges into the real start when the previous page arrives. */
  stepKey(step) {
    return step.startSeq ?? step.events[0]?.seq ?? `step-${step.step}`;
  }
  /** Step index whose events carry the given message id (-1 when absent). */
  indexOfMessage(messageId) {
    if (!messageId) return -1;
    for (let si = this.steps.length - 1; si >= 0; si--) {
      if (this.steps[si].events.some((e) => {
        const d = e.data ?? {};
        return (d.id ?? d.message?.id) === messageId;
      })) return si;
    }
    return -1;
  }
  /** Load older pages until at least `minCount` steps are loaded (or the
   *  session's first step is reached). Used by jumps and Home. */
  async ensureCount(minCount, maxPages = 80) {
    for (let i = 0; i < maxPages; i++) {
      if (!this.hasMore || this.steps.length >= minCount) break;
      this.app.setStatus(`\u52A0\u8F7D\u66F4\u65E9\u8F68\u8FF9\u2026\uFF08\u5DF2\u52A0\u8F7D ${this.steps.length} \u6B65\uFF09`);
      await this.loadOlder();
    }
    this.app.setStatus("");
  }
  /** The visible window is a SEQ RANGE (first-event seqs are globally unique
   *  and monotonic; the server's step numbers restart after compactions and
   *  cannot be used as boundaries). null = follow the tail (newest 20). */
  setWindow(loSeq, hiSeq) {
    this.winSeqLo = loSeq;
    this.winSeqHi = hiSeq;
    this.buildLines();
  }
  /** Tail-follow window: the newest 20 loaded steps. */
  #tailWindow() {
    const n = this.steps.length;
    if (n === 0) return;
    const lo = Math.max(0, n - 20);
    this.winSeqLo = this.stepKey(this.steps[lo]);
    this.winSeqHi = this.stepKey(this.steps[n - 1]);
  }
  /** Seq of the step at the top of the viewport (for anchoring after growth). */
  #topVisibleSeq() {
    const si = this.stepLines[this.view.scrollY];
    return si !== void 0 ? this.stepKey(this.steps[si]) : null;
  }
  /** Scroll so the given step seq sits at the top of the viewport. */
  #anchorScroll(seq) {
    const li = this.stepLines.findIndex((si) => this.stepKey(this.steps[si]) === seq);
    if (li >= 0) this.view.scrollY = Math.max(0, Math.min(li, this.view.maxScroll()));
  }
  /** Scroll to a step: open a ±20 window around it (loading older pages on
   *  demand), auto-expand and highlight the step. */
  async jumpToStep(si) {
    if (si < 0 || si >= this.steps.length) return;
    const key = this.stepKey(this.steps[si]);
    this.expandedSteps.add(key);
    this.selectedStepKey = key;
    this.flashKey = key;
    this.flashUntil = Date.now() + 3e3;
    for (let i = 0; i < 80 && this.hasMore; i++) {
      if (this.steps.findIndex((s) => this.stepKey(s) === key) >= 20) break;
      await this.loadOlder();
    }
    const idx = this.steps.findIndex((s) => this.stepKey(s) === key);
    if (idx < 0) return;
    const lo = Math.max(0, idx - 20), hi = Math.min(this.steps.length - 1, idx + 20);
    this.setWindow(this.stepKey(this.steps[lo]), this.stepKey(this.steps[hi]));
    const li = this.stepLines.indexOf(idx);
    this.view.scrollY = li >= 0 ? Math.max(0, Math.min(li - 2, this.view.maxScroll())) : 0;
    this.app.redraw();
  }
  /** PgUp: extend the window 10 steps upward (loading older if needed),
   *  keeping the view anchored on the step that was at the top. */
  async extendUp() {
    if (this.winSeqLo == null) this.#tailWindow();
    if (this.steps.length === 0) return;
    let topIdx = this.steps.findIndex((s) => this.stepKey(s) === this.winSeqLo);
    if (topIdx < 0) topIdx = 0;
    if (topIdx === 0 && !this.hasMore) {
      this.app.toast("\u5DF2\u5230\u6700\u65E9\u6B65\u9AA4");
      return;
    }
    for (let i = 0; i < 80 && this.hasMore && topIdx < 10; i++) {
      await this.loadOlder();
      topIdx = this.steps.findIndex((s) => this.stepKey(s) === this.winSeqLo);
    }
    const anchorSeq = this.#topVisibleSeq();
    this.winSeqLo = this.stepKey(this.steps[Math.max(0, topIdx - 10)]);
    this.buildLines();
    if (anchorSeq != null) this.#anchorScroll(anchorSeq);
    this.app.redraw();
  }
  /** PgDn: extend the window 10 steps downward (the newer steps are already
   *  loaded — the tail is always kept). */
  extendDown() {
    if (this.winSeqLo == null) this.#tailWindow();
    if (this.steps.length === 0) return;
    let bottomIdx = this.steps.length - 1;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.stepKey(this.steps[i]) <= this.winSeqHi) {
        bottomIdx = i;
        break;
      }
    }
    const target = Math.min(this.steps.length - 1, bottomIdx + 10);
    if (target === bottomIdx) {
      this.app.toast("\u5DF2\u5230\u6700\u65B0\u6B65\u9AA4");
      return;
    }
    this.winSeqHi = this.stepKey(this.steps[target]);
    this.buildLines();
    this.app.redraw();
  }
  /** Home: jump to the very first steps (loading all the way back). */
  async gotoHome() {
    for (let i = 0; i < 80 && this.hasMore; i++) {
      this.app.setStatus(`\u52A0\u8F7D\u5168\u90E8\u6B65\u9AA4\u2026\uFF08\u5DF2\u52A0\u8F7D ${this.steps.length} \u6B65\uFF09`);
      await this.loadOlder();
    }
    this.app.setStatus("");
    if (this.steps.length === 0) return;
    const hi = Math.min(19, this.steps.length - 1);
    this.setWindow(this.stepKey(this.steps[0]), this.stepKey(this.steps[hi]));
    this.view.scrollY = 0;
    this.app.toast("\u5DF2\u8DF3\u5230\u6700\u65E9\u6B65\u9AA4");
    this.app.redraw();
  }
  /** End: jump to the newest steps. */
  gotoEnd() {
    if (this.steps.length === 0) return;
    const lo = Math.max(0, this.steps.length - 20);
    this.setWindow(this.stepKey(this.steps[lo]), this.stepKey(this.steps[this.steps.length - 1]));
    this.view.scrollY = this.view.maxScroll();
    this.app.toast("\u5DF2\u8DF3\u5230\u6700\u65B0\u6B65\u9AA4");
    this.app.redraw();
  }
  /** Chat → trajectory jump target: load the current session's steps (if not
   *  already), page back until the message's step is loaded, then jump. */
  async focusMessage(messageId) {
    if (this.sessionId !== this.app.currentSession || this.steps.length === 0) {
      await this.load(this.app.currentSession);
    }
    let si = this.indexOfMessage(messageId);
    for (let i = 0; si < 0 && this.hasMore && i < 10; i++) {
      await this.loadOlder();
      si = this.indexOfMessage(messageId);
    }
    if (si < 0 && messageId) {
      await this.ensureCount(Infinity, 60);
      si = this.indexOfMessage(messageId);
    }
    if (si >= 0) {
      const S = this.steps[si].step;
      await this.jumpToStep(si);
      this.app.toast(`\u5DF2\u5B9A\u4F4D\u5230 step ${S}`);
    } else if (this.steps.length) {
      await this.jumpToStep(this.steps.length - 1);
      this.app.toast(messageId ? "\u5BF9\u5E94\u6B65\u9AA4\u4E0D\u5728\u5DF2\u52A0\u8F7D\u7A97\u53E3" : "\u6D88\u606F\u672A\u5173\u8054\u6B65\u9AA4\uFF0C\u5DF2\u5230\u6700\u65B0\u6B65\u9AA4");
    }
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.view.x = x;
    this.view.y = y;
    this.view.w = w;
    this.view.h = h;
    this.buildLines();
  }
  async load(sessionId) {
    if (this.sessionId === sessionId && this.steps.length > 0) {
      this.loading = false;
      this.buildLines();
      this.app.redraw();
      return;
    }
    if (this.loadPromise && this.loadTarget === sessionId) return this.loadPromise;
    const token = (this.loadToken ?? 0) + 1;
    this.loadToken = token;
    this.loadTarget = sessionId;
    const promise = this.#doLoad(sessionId, token);
    this.loadPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
        this.loadTarget = null;
      }
    }
  }
  async #doLoad(sessionId, token) {
    this.sessionId = sessionId;
    this.loading = true;
    this.steps = [];
    this.allEvents = [];
    this.stats = null;
    this.hasMore = false;
    this.minSeq = null;
    this.expandedSteps.clear();
    this.selectedStepKey = null;
    this.visibleStepIndices = [];
    this.flashKey = null;
    this.flashUntil = 0;
    this.winSeqLo = null;
    this.winSeqHi = null;
    this.query = "";
    this.view.scrollY = 0;
    this.app.setStatus("\u52A0\u8F7D\u8F68\u8FF9\u2026");
    try {
      const h = await this.app.api.call("session.history", { sessionId, maxMessages: 20 });
      if (this.sessionId !== sessionId || this.loadToken !== token) return;
      this.stats = h.projections?.values?.sessionStats ?? null;
      this.minSeq = h.events[0]?.event?.seq ?? null;
      this.hasMore = h.hasMore;
      const bySeq = /* @__PURE__ */ new Map();
      for (const wrapped of h.events ?? []) {
        const seq = wrapped?.event?.seq;
        if (seq != null) bySeq.set(seq, wrapped);
      }
      this.allEvents = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
      this.build();
    } catch (e) {
      this.app.toast(`\u8F68\u8FF9\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
    }
    this.loading = false;
    this.app.setStatus("");
    this.buildLines();
    this.app.redraw();
  }
  async loadOlder() {
    if (!this.hasMore || this.loadingOlder || this.minSeq == null) return;
    const sessionId = this.sessionId;
    const token = this.loadToken;
    this.loadingOlder = true;
    this.app.setStatus("\u52A0\u8F7D\u66F4\u65E9\u8F68\u8FF9\u2026");
    try {
      const h = await this.app.api.call("session.history", { sessionId, beforeSeq: this.minSeq, maxMessages: 40 });
      if (this.sessionId !== sessionId || this.loadToken !== token) {
        this.loadingOlder = false;
        return;
      }
      if (h.events.length === 0) {
        this.hasMore = false;
      } else {
        const previousMinSeq = this.minSeq;
        this.minSeq = h.events[0]?.event?.seq ?? this.minSeq;
        this.hasMore = h.hasMore && this.minSeq < previousMinSeq;
        const bySeq = /* @__PURE__ */ new Map();
        for (const wrapped of [...h.events, ...this.allEvents]) {
          const seq = wrapped?.event?.seq;
          if (seq == null) continue;
          bySeq.set(seq, wrapped);
        }
        const selectedEventSeq = this.steps.find((step) => this.stepKey(step) === this.selectedStepKey)?.events[0]?.seq ?? null;
        const expandedEventSeqs = [...this.expandedSteps].map((key) => this.steps.find((step) => this.stepKey(step) === key)?.events[0]?.seq).filter((seq) => seq != null);
        this.allEvents = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
        this.build();
        const keyForEvent = (seq) => {
          const step = this.steps.find((candidate) => candidate.events.some((event) => event.seq === seq));
          return step ? this.stepKey(step) : null;
        };
        if (selectedEventSeq != null) this.selectedStepKey = keyForEvent(selectedEventSeq);
        this.expandedSteps = new Set(expandedEventSeqs.map(keyForEvent).filter((key) => key != null));
      }
    } catch (e) {
      this.app.toast(`\u52A0\u8F7D\u66F4\u65E9\u5931\u8D25: ${e.message}`);
    }
    this.loadingOlder = false;
    this.app.setStatus("");
    this.buildLines();
    this.app.redraw();
  }
  build() {
    const steps = [];
    let cur = null;
    let pending = [];
    for (const { event } of this.allEvents) {
      const d = event.data ?? {};
      if (event.type === "turn/start") {
        if (cur && cur.events.length) steps.push(cur);
        else if (pending.length) steps.push({ events: pending, step: "?", startSeq: null, partial: true });
        cur = null;
        pending = [event];
      } else if (event.type === "step/start") {
        if (cur && cur.events.length) steps.push(cur);
        if (pending.length && pending[0]?.type !== "turn/start") {
          steps.push({ events: pending, step: "?", startSeq: null, partial: true });
          pending = [];
        }
        cur = { events: [...pending, event], step: d.step ?? steps.length + 1, turn: d.turn ?? pending[0]?.data?.turn, startSeq: event.seq };
        pending = [];
      } else if (!cur) {
        pending.push(event);
      } else {
        cur.events.push(event);
      }
    }
    if (!cur && pending.length) cur = { events: pending, step: "?", turn: pending.find((event) => event.type === "turn/start")?.data?.turn, startSeq: null, partial: true };
    if (cur && cur.events.length) steps.push(cur);
    this.steps = steps;
  }
  buildLines() {
    const w = Math.max(40, this.w - 2);
    const N = this.totalSteps();
    let loSeq = this.winSeqLo, hiSeq = this.winSeqHi;
    if (loSeq == null && this.steps.length) {
      const lo = Math.max(0, this.steps.length - 20);
      loSeq = this.stepKey(this.steps[lo]);
      hiSeq = this.stepKey(this.steps[this.steps.length - 1]);
    }
    const winIdxLo = this.steps.findIndex((s) => this.stepKey(s) === loSeq);
    const winIdxHi = this.steps.findIndex((s) => this.stepKey(s) === hiSeq);
    if (this.steps.length && (winIdxLo < 0 || winIdxHi < 0)) {
      loSeq = this.stepKey(this.steps[Math.max(0, this.steps.length - 20)]);
      hiSeq = this.stepKey(this.steps[this.steps.length - 1]);
      this.winSeqLo = loSeq;
      this.winSeqHi = hiSeq;
    }
    const safeLo = this.steps.findIndex((s) => this.stepKey(s) === loSeq);
    const safeHi = this.steps.findIndex((s) => this.stepKey(s) === hiSeq);
    const loStepNum = this.steps[safeLo]?.step ?? "?";
    const hiStepNum = this.steps[safeHi]?.step ?? "?";
    const lines = [];
    lines.push([{ t: "\u8F68\u8FF9 \u2014 \u2191\u2193 \u9009\u62E9 \xB7 Ctrl+\u2191\u2193 \u6EDA\u52A8 \xB7 Space \u5C55\u5F00 \xB7 Enter \u8F6C\u8DF3\u5BF9\u8BDD \xB7 Ctrl+R \u83DC\u5355 \xB7 PgUp/PgDn \u52A0\u8F7D", fg: K.ACCENT, bold: true }]);
    if (this.hasMore) lines.push([{ t: "\u25B2 \u66F4\u65E9\u6B65\u9AA4\uFF08\u70B9\u51FB / PgUp \u5411\u4E0A\u52A0\u8F7D 10 \u6B65\uFF09", fg: K.FAINT }]);
    else lines.push([{ t: "" }]);
    const st = this.stats;
    if (st) {
      lines.push([{ t: `\u56DE\u5408 ${st.turns} \xB7 \u6B65\u9AA4 ${st.steps} \xB7 LLM ${fmtMs(st.llmMs)} \xB7 \u5DE5\u5177 ${fmtMs(st.toolMs)}`, fg: K.DIM }]);
    }
    lines.push([{ t: `\u7A97\u53E3 #${safeLo + 1}\u2013#${safeHi + 1}\uFF08\u5DF2\u52A0\u8F7D ${this.steps.length}${this.hasMore ? "+" : ""}\uFF09\xB7 step ${loStepNum}\u2013${hiStepNum}${this.winSeqLo == null ? "\uFF08\u8DDF\u968F\u6700\u65B0\uFF09" : ""}\uFF1A`, fg: K.DIM, underline: true }]);
    this.stepLines = [];
    const list = (this.query ? this.steps.filter((t) => t.events.some((e) => {
      const d = e.data ?? {};
      const hay = `${e.type} ${d.name ?? ""} ${typeof d.content === "string" ? d.content : ""}`.toLowerCase();
      return hay.includes(this.query.toLowerCase());
    })) : this.steps.filter((s) => {
      const k = this.stepKey(s);
      return k >= loSeq && k <= hiSeq;
    })).reverse();
    this.visibleStepIndices = list.map((step) => this.steps.indexOf(step));
    if (this.visibleStepIndices.length && !this.visibleStepIndices.some((si) => this.stepKey(this.steps[si]) === this.selectedStepKey)) {
      this.selectedStepKey = this.stepKey(this.steps[this.visibleStepIndices[0]]);
    }
    for (const step of list) {
      const si = this.steps.indexOf(step);
      const tools = [...new Set(step.events.filter((e) => e.type === "tool/call").map((e) => e.data?.name))];
      const hasReasoning = step.events.some((e) => e.type === "assistant/chunk" && e.data?.chunk?.blockType === "reasoning");
      const t0 = step.events[0]?.time, t1 = step.events[step.events.length - 1]?.time;
      const isLiveTail = this.app.chat?.running && this.winSeqLo == null && si === this.steps.length - 1;
      const dur = isLiveTail ? `\u23F1${fmtMs(Date.now() - (t0 ?? Date.now()))}` : t0 && t1 ? fmtMs(t1 - t0) : "\u2014";
      const bg = tools.length ? T.CARD : hasReasoning ? T.THINKBG : T.CARD;
      const summary = tools.slice(0, 3).join(",") || (hasReasoning ? "\u6A21\u578B\u63A8\u7406" : "\u7EAF\u6587\u672C");
      const open = this.expandedSteps.has(this.stepKey(step));
      const flash = this.flashKey === this.stepKey(step) && Date.now() < this.flashUntil;
      const rowBg = flash ? T.ACCENT : bg;
      const selected = this.stepKey(step) === this.selectedStepKey;
      const label = `${selected ? "=>" : "  "} ${open ? "\u25BE" : "\u25B8"} step ${String(step.step).padStart(3)}  ${pad(dur, 8)}  ${summary}  ${open ? "[\u6298\u53E0]" : "[\u5C55\u5F00]"}`;
      const segs = [{ t: label, fg: flash ? T.SELFG : K.TXT, bg: rowBg, bold: true }];
      const fill = w - strWidth(label);
      if (fill > 0) segs.push({ t: " ".repeat(fill), bg: rowBg });
      lines.push(segs);
      this.stepLines[lines.length - 1] = si;
      if (open) {
        const evs = step.events;
        let prev = null;
        for (const e of evs) {
          const dt = prev != null && e.time != null ? ` \u0394${fmtMs(e.time - prev)}` : "";
          lines.push([{ t: `    #${String(e.seq).padStart(4)}${dt} ${truncate(this.#eventSummary(e), w - 12 - strWidth(dt))}`, fg: K.DIM, bg }]);
          this.stepLines[lines.length - 1] = si;
          prev = e.time;
        }
      }
    }
    this.view.setLines(lines);
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    if (this.loading && this.steps.length === 0) {
      screen.text(this.x + 2, this.y + 1, "\u52A0\u8F7D\u8F68\u8FF9\u2026", { fg: K.FAINT });
      return;
    }
    if (this.app.chat?.running && this.winSeqLo == null) {
      if (Date.now() - (this.liveTickAt ?? 0) > 1e3) {
        this.liveTickAt = Date.now();
        this.buildLines();
      }
      if (!this.refreshing && Date.now() - (this.tailFetchAt ?? 0) > 4e3) {
        this.tailFetchAt = Date.now();
        this.#refreshTail();
      }
    }
    this.view.render(screen);
  }
  /** Re-fetch the tail window while following the live turn. */
  async #refreshTail() {
    if (!this.sessionId || this.loadingOlder) return;
    const sessionId = this.sessionId;
    const token = this.loadToken;
    this.refreshing = true;
    try {
      const h = await this.app.api.call("session.history", { sessionId, maxMessages: 20 });
      if (this.sessionId !== sessionId || this.loadToken !== token) {
        this.refreshing = false;
        return;
      }
      if (this.loadingOlder || this.winSeqLo != null) {
        this.refreshing = false;
        return;
      }
      const bySeq = /* @__PURE__ */ new Map();
      for (const wrapped of h.events ?? []) {
        const seq = wrapped?.event?.seq;
        if (seq != null) bySeq.set(seq, wrapped);
      }
      this.allEvents = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
      this.minSeq = this.allEvents[0]?.event?.seq ?? this.minSeq;
      this.hasMore = h.hasMore;
      this.stats = h.projections?.values?.sessionStats ?? this.stats;
      this.build();
      this.buildLines();
      this.app.redraw();
    } catch {
    }
    this.refreshing = false;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 2) {
      const y = ev.y - this.view.y + this.view.scrollY;
      const si = this.stepLines[y];
      const step = si !== void 0 ? this.steps[si] : null;
      if (step) {
        this.selectedStepKey = this.stepKey(step);
        this.buildLines();
        this.app.openMenu(this.#menuItems(si), ev);
        return true;
      }
      if (this.hasMore && y === 1) {
        this.app.openMenu([{ label: "\u52A0\u8F7D\u66F4\u65E9\u6B65\u9AA4", action: () => this.loadOlder() }], ev);
        return true;
      }
      return this.view.inside(ev.x, ev.y);
    }
    if (this.view.onMouse(ev)) return true;
    if (ev.kind === "press" && ev.button === 0 && this.view.inside(ev.x, ev.y)) return true;
    return false;
  }
  onKey(ev) {
    if (ev.type === "text" && ev.text === " ") {
      const si = this.#selectedIndex();
      if (si >= 0) this.#toggleStep(si);
      return true;
    }
    if (ev.type === "text") {
      this.query += ev.text;
      this.buildLines();
      this.app.redraw();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      if (this.query) {
        this.query = "";
        this.buildLines();
        this.app.redraw();
        return true;
      }
      this.app.setMode("chat");
      return true;
    }
    if (ev.name === "backspace") {
      this.query = this.query.slice(0, -1);
      this.buildLines();
      this.app.redraw();
      return true;
    }
    if (ev.ctrl && (ev.name === "up" || ev.name === "down")) {
      this.view.scroll(ev.name === "up" ? -1 : 1);
      this.app.redraw();
      return true;
    }
    if (ev.name === "up" || ev.name === "down") return this.#moveSelection(ev.name === "up" ? -1 : 1);
    if (ev.name === "char" && ev.key === " " && !ev.ctrl) {
      const si = this.#selectedIndex();
      if (si >= 0) this.#toggleStep(si);
      return true;
    }
    if (ev.name === "enter") {
      const si = this.#selectedIndex();
      if (si >= 0) this.app.jumpToChatStep(si);
      return true;
    }
    if (ev.name === "char" && ev.key === "r" && ev.ctrl) return this.openSelectedMenu();
    if (ev.name === "char" && ev.key === "r" && !ev.ctrl) {
      this.winSeqLo = this.winSeqHi = null;
      this.steps = [];
      this.selectedStepKey = null;
      this.load(this.sessionId);
      return true;
    }
    if (ev.name === "pgup") {
      this.extendUp();
      return true;
    }
    if (ev.name === "pgdn") {
      this.extendDown();
      return true;
    }
    if (ev.name === "home") {
      this.gotoHome();
      return true;
    }
    if (ev.name === "end") {
      this.gotoEnd();
      return true;
    }
    return false;
  }
};
function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return "\u2014";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  return `${(ms / 6e4).toFixed(1)}m`;
}
function kittyCapable(env = process.env) {
  if (env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "WezTerm" || env.TERM === "xterm-kitty") return true;
  if (env.DSH_TUI_NO_KITTY) return false;
  return false;
}
var ImagePopup = class extends Popup {
  constructor({ app, ref, sessionId, refs = null, index = 0, returnTo = null }) {
    const w = Math.min(80, app.screen.w - 4), h = Math.min(24, app.screen.h - 4);
    super({
      x: Math.floor((app.screen.w - w) / 2),
      y: Math.floor((app.screen.h - h) / 2),
      w,
      h,
      title: `\u25A3 ${truncate(ref?.name ?? "image", 50)}`,
      lines: [[{ t: "\u52A0\u8F7D\u4E2D\u2026", fg: K.DIM }]],
      buttons: [],
      onAction: () => this.closePreview()
    });
    this.app = app;
    this.refs = refs && refs.length > 0 ? refs : [ref];
    this.index = Math.min(index, this.refs.length - 1);
    this.ref = this.refs[this.index];
    this.sessionId = sessionId;
    this.returnTo = returnTo;
    this.data = null;
    this.imageKey = "";
    this.kittySentKey = "";
    this.kittyId = Math.floor(Math.random() * 2147483646) + 1;
    this.kittyIds = /* @__PURE__ */ new Set([this.kittyId]);
    this.pixelWidth = ref?.width ?? null;
    this.pixelHeight = ref?.height ?? null;
    this.load();
  }
  #deleteKittyImage() {
    if (this.kittyId && this.app.term?.output) this.app.term.output.write(`\x1B_Ga=d,d=i,i=${this.kittyId},q=2\x1B\\`);
    if (this.app.screen) this.app.screen.prev = null;
  }
  #show(idx) {
    this.#deleteKittyImage();
    this.index = (idx + this.refs.length) % this.refs.length;
    this.ref = this.refs[this.index];
    this.data = null;
    this.chafaTmp = null;
    this.kittySentKey = "";
    this.kittyId = Math.floor(Math.random() * 2147483646) + 1;
    this.kittyIds.add(this.kittyId);
    this.lines = [[{ t: "\u52A0\u8F7D\u4E2D\u2026", fg: K.DIM }]];
    this.app.redraw();
    this.load();
  }
  galleryTitle() {
    const nm = this.ref?.name ?? "image";
    const dims = this.ref?.width ? ` \xB7 ${this.ref.width}\xD7${this.ref.height}` : "";
    return `\u25A3 ${truncate(nm, 40)}${this.refs.length > 1 ? ` (${this.index + 1}/${this.refs.length})` : ""}${dims}`;
  }
  onKey(ev) {
    if (ev.type === "key" && ev.name === "left" && this.refs.length > 1) {
      this.#show(this.index - 1);
      return true;
    }
    if (ev.type === "key" && ev.name === "right" && this.refs.length > 1) {
      this.#show(this.index + 1);
      return true;
    }
    if (ev.type === "key" && ev.name === "enter") {
      this.openExternal();
      return true;
    }
    if (ev.type === "key" && ev.name === "escape") {
      this.closePreview();
      return true;
    }
    if (ev.type === "key" && ev.name === "char" && ev.key === "y") {
      this.copyImage();
      return true;
    }
    return true;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const now = Date.now();
      if (this.lastClickAt && now - this.lastClickAt < 400) {
        this.openExternal();
        this.lastClickAt = 0;
      } else this.lastClickAt = now;
      return true;
    }
    if (ev.kind === "press" && ev.button === 2) {
      this.app.openMenu([{ label: "\u6253\u5F00\u7CFB\u7EDF\u67E5\u770B\u5668", action: () => this.openExternal() }, { label: "\u590D\u5236\u56FE\u7247", action: () => this.copyImage() }], ev);
      return true;
    }
    return super.onMouse(ev);
  }
  closePreview() {
    this.#deleteKittyImage();
    if (this.app.term?.output) for (const id of this.kittyIds) this.app.term.output.write(`\x1B_Ga=d,d=i,i=${id},q=2\x1B\\`);
    if (this.app.screen) this.app.screen.prev = null;
    if (this.returnTo) {
      this.returnTo.sel = Math.max(0, Math.min(this.index, this.returnTo.items().length - 1));
      this.app.overlay = this.returnTo;
      this.app.focus(this.returnTo);
      this.app.redraw();
    } else this.app.closeOverlay();
  }
  copyImage() {
    try {
      copyImageToClipboard(this.data, this.ref?.mediaType ?? "image/png");
      this.app.toast("\u56FE\u7247\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F");
    } catch (e) {
      this.app.toast(`\u590D\u5236\u56FE\u7247\u5931\u8D25: ${e.message}`);
    }
  }
  async load() {
    try {
      let attachment;
      if (this.ref?.data && this.ref?.mediaType) {
        this.data = Buffer.from(this.ref.data, "base64");
        attachment = this.ref;
      } else {
        if (!this.sessionId || !this.ref?.attachmentId) throw new Error("\u65E0\u9644\u4EF6\u5F15\u7528");
        const res = await this.app.api.call("session.attachment", { sessionId: this.sessionId, attachmentId: this.ref.attachmentId });
        this.data = Buffer.from(res.data ?? "", "base64");
        attachment = res.attachment;
      }
      if (kittyCapable() && attachment.mediaType !== "image/png") {
        try {
          const converted = spawnSyncSafeBuffer("magick", ["-", "png:-"], this.data, 5e3);
          if (converted?.length) {
            this.data = converted;
            attachment = { ...attachment, mediaType: "image/png" };
          }
        } catch {
        }
      }
      this.pixelWidth = attachment.width ?? this.pixelWidth;
      this.pixelHeight = attachment.height ?? this.pixelHeight;
      if ((!this.pixelWidth || !this.pixelHeight) && this.data) {
        try {
          const identify = spawnSyncSafe("magick", ["identify", "-format", "%w %h", "-"], 4e3, this.data);
          const [pw, ph] = String(identify ?? "").trim().split(/\s+/).map(Number);
          if (pw > 0 && ph > 0) {
            this.pixelWidth = pw;
            this.pixelHeight = ph;
          }
        } catch {
        }
      }
      this.title = this.galleryTitle();
      this.lines = [[{ t: `${attachment.mediaType} \xB7 ${attachment.width ? `${attachment.width}\xD7${attachment.height} \xB7 ` : ""}${Math.round(this.data.length / 1024)}KB`, fg: K.DIM }], [{ t: `Enter/\u53CC\u51FB \u9ED8\u8BA4\u7A0B\u5E8F \xB7 y \u590D\u5236 \xB7 Esc \u5173\u95ED${this.refs.length > 1 ? " \xB7 \u2190/\u2192 \u5207\u6362" : ""}`, fg: K.FAINT }]];
      this.renderImage();
    } catch (e) {
      this.lines = [[{ t: `\u52A0\u8F7D\u5931\u8D25: ${e.message}`, fg: K.ERR }]];
    }
    this.app.redraw();
  }
  renderImage() {
    if (kittyCapable()) {
      this.kittyLines = 0;
      this.kittyCols = 0;
      this.imageKey = `${this.data.length}:${Date.now()}`;
      this.app.toast("kitty \u56FE\u5F62\u534F\u8BAE\u663E\u793A");
      return;
    }
    if (this.tryChafa()) return;
    this.lines = [
      [{ t: `${this.ref?.mediaType ?? "image"} \xB7 ${this.pixelWidth && this.pixelHeight ? `${this.pixelWidth}\xD7${this.pixelHeight} \xB7 ` : ""}${Math.round((this.data?.length ?? 0) / 1024)}KB`, fg: K.TXT }],
      [{ t: "\u7EC8\u7AEF\u4E0D\u652F\u6301 Kitty \u56FE\u5F62\u534F\u8BAE\uFF1BEnter \u7528\u9ED8\u8BA4\u7A0B\u5E8F\u6253\u5F00 \xB7 y \u590D\u5236 \xB7 Esc \u8FD4\u56DE", fg: K.DIM }]
    ];
  }
  tryChafa() {
    try {
      const tmp = (0, import_node_path6.join)((0, import_node_os4.tmpdir)(), `dsh-tui-${Date.now()}.${(0, import_node_path6.extname)(this.ref?.name ?? "img") || "png"}`);
      (0, import_node_fs6.writeFileSync)(tmp, this.data);
      const out = spawnSyncSafe("chafa", ["--format", "symbols", "--size", `${Math.min(70, this.w - 6)}x${Math.max(4, this.h - 6)}`, tmp], 4e3);
      if (out) {
        this.lines = out.split("\n").map((l) => [{ t: truncate(l, this.w - 4), fg: K.TXT }]);
        this.chafaTmp = tmp;
        return true;
      }
    } catch {
    }
    return false;
  }
  openExternal() {
    try {
      const ext = (0, import_node_path6.extname)(this.ref?.name ?? "img") || ".png";
      const tmp = (0, import_node_path6.join)((0, import_node_os4.tmpdir)(), `dsh-tui-${Date.now()}${ext}`);
      (0, import_node_fs6.writeFileSync)(tmp, this.data ?? Buffer.alloc(0));
      openExternal(tmp);
      this.app.toast(`\u5DF2\u5728\u67E5\u770B\u5668\u4E2D\u6253\u5F00: ${tmp}`);
    } catch (e) {
      this.app.toast(`\u6253\u5F00\u5931\u8D25: ${e.message}`);
    }
  }
  kittyTransmit() {
    if (!this.data || !kittyCapable() || this.app.term?.kitty === false) return "";
    const maxW = Math.min(70, this.w - 6), maxH = Math.max(4, this.h - 7);
    const aspect = this.pixelWidth && this.pixelHeight ? this.pixelWidth / this.pixelHeight : 1;
    let w = maxW, h = Math.max(1, Math.round(w / Math.max(0.05, aspect) / 2));
    if (h > maxH) {
      h = maxH;
      w = Math.max(1, Math.min(maxW, Math.round(h * aspect * 2)));
    }
    if (this.kittySentKey === this.imageKey) return "";
    this.kittySentKey = this.imageKey;
    const b64 = this.data.toString("base64");
    const chunks = [];
    for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
    const payload = chunks.map((c, i) => i === 0 ? `\x1B_Ga=t,f=100,i=${this.kittyId},q=2,m=${chunks.length === 1 ? 0 : 1};${c}\x1B\\` : `\x1B_Gm=${i === chunks.length - 1 ? 0 : 1};${c}\x1B\\`).join("");
    const move = `\x1B[${this.y + 4};${this.x + 3}H`;
    const sourceAspect = this.pixelWidth && this.pixelHeight ? this.pixelWidth / this.pixelHeight : 1;
    let cols = w, rows = Math.max(1, Math.round(cols / sourceAspect / 2));
    if (rows > h) {
      rows = h;
      cols = Math.max(1, Math.min(w, Math.round(rows * sourceAspect * 2)));
    }
    const place = `\x1B_Ga=p,i=${this.kittyId},c=${cols},r=${rows},q=2\x1B\\`;
    return payload + move + place;
  }
};
function spawnSyncSafeBuffer(cmd, args, input, timeoutMs) {
  try {
    const r = (0, import_node_child_process3.spawnSync)(cmd, args, { input, timeout: timeoutMs, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
function spawnSyncSafe(cmd, args, timeoutMs, input = null) {
  try {
    return (0, import_node_child_process3.execFileSync)(cmd, args, { input, timeout: timeoutMs, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
var DEFAULT_COMMANDS = [
  { name: "compact", description: "Compact older conversation history", input: { hint: "" } },
  { name: "export", description: "Download this Session log as a ZIP archive", input: { hint: "" } },
  { name: "feedback", description: "record feedback about this session", input: { hint: "<text>" } },
  { name: "goal", description: "set or view the goal for a long-running task", input: { hint: "[<objective>|clear|edit <objective>|pause|resume]" } },
  { name: "permission", description: "Switch the permission preset (sandbox mode + approval policy)", input: { hint: "<preset>" } },
  { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } }
];
var ControlPanel = class extends Widget {
  constructor(app, { startPage = 0 } = {}) {
    const w = Math.min(104, app.screen.w - 4);
    const h = Math.min(24, app.screen.h - 4);
    super({ x: Math.floor((app.screen.w - w) / 2), y: Math.floor((app.screen.h - h) / 2), w, h });
    this.app = app;
    this.pages = ["\u5FEB\u6377\u952E", "\u547D\u4EE4", "\u8BBE\u7F6E", "\u63D2\u4EF6"];
    this.page = startPage;
    this.pluginQuery = "";
    this.pluginFilter = false;
    this.sel = 0;
    this.scroll = 0;
    this.commands = DEFAULT_COMMANDS;
    this.plugins = null;
    this.pluginError = null;
    this.loadCommands();
    this.loadPlugins();
  }
  editShortcut(id) {
    const back = this, b = keyBindings()[id];
    const input = new Input({ x: this.x + 8, y: this.y + 7, w: this.w - 16, h: 1, prompt: "JSON: ", allowEmptyEnter: true, onEnter(value) {
      try {
        const parsed = JSON.parse(value);
        if (!["normal", "insert", "all"].includes(parsed.mode) || typeof parsed.key !== "string" || !parsed.key.trim()) throw new Error('\u9700\u8981 {"mode":"normal|insert|all","key":"..."[, "key2":"..."]}');
        const k2 = typeof parsed.key2 === "string" ? parsed.key2.trim() : "";
        const vk = validateKeySpec(parsed.key);
        if (!vk.ok) throw new Error(`key: ${vk.reason}`);
        if (k2) {
          const vk2 = validateKeySpec(k2);
          if (!vk2.ok) throw new Error(`key2: ${vk2.reason}`);
        }
        if (!setKeyBinding(id, { mode: parsed.mode, key: parsed.key.trim(), key2: k2 })) throw new Error("\u5199\u5165\u914D\u7F6E\u5931\u8D25");
        back.app.overlay = back;
        back.app.focus(back);
        back.app.toast("\u5FEB\u6377\u952E\u5DF2\u4FDD\u5B58");
      } catch (e) {
        input.setValue(value);
        back.app.toast(`\u8BED\u6CD5\u9519\u8BEF: ${e.message}`);
      }
    } });
    input.setValue(JSON.stringify(b));
    const pop = new Popup({ x: this.x + 6, y: this.y + 5, w: this.w - 12, h: 7, title: `\u7F16\u8F91 tui-config.json \xB7 keyBindings.${id}`, lines: [`\u914D\u7F6E\u9879: keyBindings.${id} \xB7 \u4E24\u4E2A\u69FD\u4F4D key\uFF08\u4E3B\uFF09/ key2\uFF08\u5907\uFF09`, `\u793A\u4F8B: {"mode":"normal","key":"Ctrl+F","key2":"/"}`], buttons: [] });
    pop.render = (s) => {
      Popup.prototype.render.call(pop, s);
      input.render(s);
    };
    pop.onKey = (ev) => {
      if (ev.type === "key" && ev.name === "escape") {
        back.app.overlay = back;
        back.app.focus(back);
        return true;
      }
      return input.onKey(ev);
    };
    this.app.overlay = pop;
    this.app.focus(input);
  }
  async loadCommands() {
    try {
      const agentId = this.app.currentSession;
      if (agentId) {
        const cmds = await this.app.api.rpcCall("commands/list", { agentId });
        if (Array.isArray(cmds) && cmds.length) this.commands = cmds;
      }
    } catch {
    }
    this.app.redraw();
  }
  async loadPlugins() {
    try {
      const res = await this.app.api.rpcCall("pluginInventory/list", {});
      this.plugins = res.entries ?? [];
    } catch (e) {
      this.pluginError = e.message;
    }
    this.app.redraw();
  }
  shortcutItems() {
    const b = keyBindings();
    const row = (id, desc) => [`${(b[id]?.mode ?? "all").toUpperCase()}	${describeSpec(b[id]?.key)}	${describeSpec(b[id]?.key2)}`, desc, null, id];
    return [
      row("think", "\u601D\u8003\u5757 \u5C55\u5F00/\u6298\u53E0"),
      row("tools", "\u5DE5\u5177\u5757 \u5C55\u5F00/\u6298\u53E0"),
      row("insert", "\u8FDB\u5165\u8F93\u5165"),
      row("leaveInsert", "\u9000\u51FA\u8F93\u5165"),
      row("sessionFilter", "\u8DE8\u4F1A\u8BDD\u641C\u7D22"),
      row("newSession", "\u65B0\u5EFA\u4F1A\u8BDD"),
      row("top", "\u8DF3\u5230\u9996\u4E2A\u6B63\u6587\u5757"),
      row("bottom", "\u8DF3\u5230\u6700\u65B0\u6B63\u6587\u5757"),
      row("prevQuestion", "\u4E0A\u4E00\u63D0\u95EE\u7684\u7EC8\u70B9"),
      row("nextQuestion", "\u4E0B\u4E00\u63D0\u95EE\u7684\u7EC8\u70B9"),
      row("expandInput", "\u8F93\u5165\u680F \u5C55\u5F00/\u6298\u53E0"),
      row("copyInput", "\u590D\u5236\u8F93\u5165\u680F\u9009\u533A"),
      row("panel", "\u63A7\u5236\u9762\u677F"),
      row("model", "\u5207\u6362\u6A21\u578B"),
      row("trajectory", "\u8F68\u8FF9\u89C6\u56FE"),
      row("homeSwitch", "pane \u7126\u70B9\u5207\u6362"),
      row("permissionRotate", "\u6743\u9650\u6A21\u5F0F\u8F6E\u6362"),
      row("workspace", "\u5DE5\u4F5C\u533A"),
      row("settings", "\u8BBE\u7F6E"),
      row("subagent", "\u5B50\u4EE3\u7406"),
      row("skills", "\u6280\u80FD"),
      row("goal", "\u76EE\u6807"),
      row("jobs", "\u540E\u53F0\u4EFB\u52A1"),
      row("queue", "\u540E\u53F0\u961F\u5217"),
      row("busyEnter", "\u8FD0\u884C\u4E2D Enter \u7B56\u7565"),
      row("attachments", "\u9644\u4EF6\u7BA1\u7406"),
      row("stepJump", "\u6B65\u9AA4\u8F6C\u8DF3"),
      row("sidebar", "\u4FA7\u680F\u663E\u793A/\u9690\u85CF"),
      row("editConfig", "\u7F16\u8F91\u914D\u7F6E\u6587\u4EF6\uFF08\u9ED8\u8BA4\u7F16\u8F91\u5668\uFF09"),
      row("quit", "\u9000\u51FA")
    ];
  }
  items() {
    if (this.page === 0) return this.shortcutItems();
    if (this.page === 1) {
      return this.commands.map((c) => [
        `/${c.name}${c.input?.hint ? " " + c.input.hint : ""}`,
        c.description,
        () => {
          this.app.closeOverlay();
          this.app.focus(this.app.chat.input);
          this.app.chat.input.setValue(`/${c.name} `);
          this.app.redraw();
        }
      ]);
    }
    if (this.page === 2) {
      return [
        ["\u6A21\u578B\u7BA1\u7406\uFF08\u542B\u601D\u8003\u5F3A\u5EA6\uFF09", "\u5207\u6362\u6A21\u578B\u5E76\u9009\u62E9\u601D\u8003\u5F3A\u5EA6", () => {
          this.app.overlay = buildModelPicker(this.app);
        }],
        ["\u6A21\u5F0F\uFF08Agent \u9884\u8BBE\uFF09", "\u6807\u51C6 / PTC / \u6781\u7B80 / \u521B\u9020", () => {
          this.app.overlay = buildModePicker(this.app);
          this.app.redraw();
        }],
        ["\u6743\u9650\uFF08\u6C99\u7BB1 + \u5BA1\u6279\uFF09", "\u53EA\u8BFB / \u5DE5\u4F5C\u533A\u5199\u5165 / \u5B8C\u5168\u8BBF\u95EE", () => {
          this.app.overlay = buildPermissionPicker(this.app);
          this.app.redraw();
        }],
        ["\u5B8C\u6574\u8BBE\u7F6E\uFF08JSON \u7F16\u8F91\u5668\uFF09", "\u6240\u6709\u547D\u540D\u7A7A\u95F4\u7684\u539F\u59CB\u503C", () => {
          this.app.closeOverlay();
          this.app.showSettingsBuffer ? this.app.showSettingsBuffer() : this.app.setMode?.("settings");
        }],
        ["\u5207\u6362\u4E3B\u9898", "dark / light / gruvbox", () => {
          cycleTheme();
          this.app.toast(`\u4E3B\u9898: ${themeName()}`);
        }],
        ["\u4FA7\u680F\u663E\u793A/\u9690\u85CF", "nvim \u5F0F\u6574\u4F53\u6536\u8D77", () => this.app.toggleSidebar()],
        ["\u5BFC\u51FA\u5F53\u524D\u4F1A\u8BDD\u65E5\u5FD7", "\u4E0B\u8F7D ZIP", () => {
          const sess = this.app.sessions.find((x) => x.sessionId === this.app.currentSession);
          if (sess) {
            this.app.closeOverlay();
            this.app.exportSession(sess);
          }
        }],
        ["\u590D\u5236\u4F1A\u8BDD ID", "", () => this.app.copyText(this.app.currentSession ?? "")]
      ];
    }
    if (this.plugins) {
      const q = this.pluginQuery.toLowerCase();
      return this.plugins.filter((pl) => !q || `${pl.moduleName} ${pl.fiberPhase ?? ""}`.toLowerCase().includes(q)).map((pl) => [`${pl.enabled ? "\u25CF" : "\u25CB"} ${pl.moduleName}`, pl.fiberPhase ?? "", null]);
    }
    return [[this.pluginError ?? "\u63D2\u4EF6\u6E05\u5355\u52A0\u8F7D\u4E2D\u2026", "", null]];
  }
  render(screen) {
    const s = screen;
    s.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", { bg: T.PANEL });
    s.box(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, { fg: T.ACCENT, bg: T.PANEL }, " \u63A7\u5236\u9762\u677F");
    let tx = this.x + 2;
    this.pages.forEach((name, i) => {
      const sel = i === this.page;
      s.text(tx, this.y, ` ${name} `, { fg: sel ? T.SELFG : T.DIM, bg: sel ? T.ACCENT : -1, attrs: sel ? 1 : 0 });
      tx += strWidth(` ${name} `);
    });
    s.text(this.x + this.w - 18, this.y, "Tab/\u2190\u2192 \u7FFB\u9875", { fg: T.FAINT });
    const items = this.items();
    if (this.sel >= items.length) this.sel = Math.max(0, items.length - 1);
    const visible = Math.max(1, this.h - 3);
    if (this.sel < this.scroll) this.scroll = this.sel;
    else if (this.sel >= this.scroll + visible) this.scroll = this.sel - visible + 1;
    this.scroll = Math.max(0, Math.min(Math.max(0, items.length - visible), this.scroll));
    if (this.page === 0) {
      s.text(this.x + 2, this.y + 1, "MODE", { fg: T.PURPLE, bg: T.PANEL, attrs: 1 });
      s.text(this.x + 13, this.y + 1, "KEY1", { fg: T.ACCENT, bg: T.PANEL, attrs: 1 });
      s.text(this.x + 31, this.y + 1, "KEY2", { fg: T.ACCENT, bg: T.PANEL, attrs: 1 });
      s.text(this.x + 49, this.y + 1, "FUNCTION", { fg: T.OK, bg: T.PANEL, attrs: 1 });
    }
    if (this.page === 3 && this.pluginFilter) {
      s.text(this.x + 2, this.y + 1, `/ ${this.pluginQuery}`, { fg: T.ACCENT, bg: T.PANEL, attrs: 1 });
    }
    for (let i = 0; i < visible; i++) {
      const idx = this.scroll + i;
      const it = items[idx];
      if (!it) {
        s.hline(this.x + 1, this.x + this.w - 2, this.y + 2 + i, " ", { bg: T.PANEL });
        continue;
      }
      const sel = idx === this.sel;
      s.fillRect(this.x + 1, this.y + 2 + i, this.x + this.w - 2, this.y + 2 + i, " ", { bg: sel ? T.MENUSEL : T.PANEL });
      const label = it[0];
      if (this.page === 0) {
        const [mode, key1, key2] = label.split("	");
        s.text(this.x + 2, this.y + 2 + i, pad(mode, 9), { fg: T.PURPLE, bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
        s.text(this.x + 13, this.y + 2 + i, pad(truncate(key1, 16), 17), { fg: T.ACCENT, bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
        s.text(this.x + 31, this.y + 2 + i, pad(truncate(key2, 16), 17), { fg: T.ACCENT, bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
        s.text(this.x + 49, this.y + 2 + i, truncate(it[1], this.w - 52), { fg: T.OK, bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
      } else {
        s.text(this.x + 2, this.y + 2 + i, truncate(label, this.w - 34), { fg: sel ? T.BOLD : T.TXT, bg: sel ? T.MENUSEL : T.PANEL, attrs: sel ? 1 : 0 });
        if (it[1]) s.text(this.x + this.w - 30, this.y + 2 + i, truncate(it[1], 28), { fg: T.FAINT, bg: sel ? T.MENUSEL : T.PANEL });
      }
    }
    s.text(this.x + 2, this.y + this.h - 1, this.page === 0 ? "\u2191\u2193 \u9009\u62E9 \xB7 Enter \u7F16\u8F91 \xB7 Shift+Tab \u8F6E\u6362\u6A21\u5F0F \xB7 Alt+Enter \u6062\u590D\u9ED8\u8BA4 \xB7 Esc \u5173\u95ED" : this.page === 3 ? `/ \u7B5B\u9009\u63D2\u4EF6 \xB7 Ctrl+/ \u6E05\u9664 \xB7 \u2191\u2193 \u9009\u62E9 \xB7 Esc \u5173\u95ED${this.pluginQuery ? ` \xB7 ${this.pluginQuery}` : ""}` : "\u2191\u2193 \u9009\u62E9 \xB7 Enter \u6267\u884C \xB7 Esc \u5173\u95ED", { fg: T.FAINT });
  }
  onKey(ev) {
    if (this.page === 3 && this.pluginFilter) {
      if (ev.type === "text") {
        this.pluginQuery += ev.text;
        this.sel = 0;
        return true;
      }
      if (ev.type === "key" && ev.name === "backspace") {
        this.pluginQuery = this.pluginQuery.slice(0, -1);
        this.sel = 0;
        return true;
      }
      if (ev.type === "key" && ev.name === "enter") {
        this.pluginFilter = false;
        return true;
      }
      if (ev.type === "key" && ev.ctrl && (ev.key === "/" || ev.key === "_")) {
        this.pluginFilter = false;
        this.pluginQuery = "";
        return true;
      }
    }
    if (this.page === 3 && ev.type === "text" && ev.text === "/") {
      this.pluginFilter = true;
      this.pluginQuery = "";
      return true;
    }
    if (ev.type !== "key") return false;
    if (this.page === 3 && ev.name === "char" && ev.key === "/") {
      this.pluginFilter = true;
      this.pluginQuery = "";
      return true;
    }
    if (this.page === 3 && ev.ctrl && (ev.key === "/" || ev.key === "_")) {
      this.pluginQuery = "";
      return true;
    }
    if (ev.name === "escape") {
      this.app.closeOverlay();
      return true;
    }
    if (this.page === 0 && ev.name === "backtab") {
      const it = this.items()[this.sel], id = it?.[3];
      if (id) {
        const b = keyBindings()[id], modes = ["normal", "insert", "all"], mode = modes[(modes.indexOf(b.mode) + 1) % 3];
        setKeyBinding(id, { ...b, mode });
        this.app.toast(`\u9002\u7528\u6A21\u5F0F: ${mode.toUpperCase()}`);
      }
      return true;
    }
    if (this.page === 0 && ev.alt && ev.name === "enter") {
      const id = this.items()[this.sel]?.[3];
      if (id) {
        resetKeyBinding(id);
        this.app.toast("\u5DF2\u6062\u590D\u9ED8\u8BA4\u5FEB\u6377\u952E");
      }
      return true;
    }
    if (ev.name === "tab" || ev.name === "right") {
      this.page = (this.page + 1) % this.pages.length;
      this.sel = 0;
      this.app.redraw();
      return true;
    }
    if (ev.name === "backtab" || ev.name === "left") {
      this.page = (this.page + this.pages.length - 1) % this.pages.length;
      this.sel = 0;
      this.app.redraw();
      return true;
    }
    if (ev.name === "pgup" || ev.name === "home") {
      this.sel = 0;
      this.app.redraw();
      return true;
    }
    if (ev.name === "pgdn" || ev.name === "end") {
      this.sel = this.items().length - 1;
      this.app.redraw();
      return true;
    }
    if (ev.name === "up") {
      this.sel = wrapIndex(this.sel - 1, this.items().length);
      this.app.redraw();
      return true;
    }
    if (ev.name === "down") {
      this.sel = wrapIndex(this.sel + 1, this.items().length);
      this.app.redraw();
      return true;
    }
    if (ev.name === "enter") {
      const it = this.items()[this.sel];
      if (this.page === 0 && it?.[3]) {
        this.editShortcut(it[3]);
        return true;
      }
      if (it && it[2]) {
        it[2]();
        this.app.redraw();
      }
      return true;
    }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      if (ev.y === this.y) {
        let tx = this.x + 2;
        for (let i = 0; i < this.pages.length; i++) {
          const wTab = strWidth(` ${this.pages[i]} `);
          if (ev.x >= tx && ev.x < tx + wTab) {
            this.page = i;
            this.sel = 0;
            this.app.redraw();
            return true;
          }
          tx += wTab;
        }
        if (this.page === 2 && Array.isArray(this.subPages)) {
          let sx = this.x + 2 + strWidth(" \u5FEB\u6377\u952E   \u547D\u4EE4   \u8BBE\u7F6E ");
          for (let i = 0; i < this.subPages.length; i++) {
            const wTab = strWidth(` ${this.subPages[i]} `);
            if (ev.x >= sx && ev.x < sx + wTab) {
              this.subPage = i;
              this.sel = 0;
              this.app.redraw();
              return true;
            }
            sx += wTab;
          }
        }
        return true;
      }
      const idx = this.scroll + (ev.y - this.y - 2);
      const items = this.items();
      if (idx >= 0 && idx < items.length && ev.y - this.y - 2 < this.h - 3) {
        this.sel = idx;
        const it = items[idx];
        if (it && it[2]) {
          it[2]();
          this.app.redraw();
        } else this.app.redraw();
        return true;
      }
    }
    if (ev.kind === "wheel-up") {
      this.sel = wrapIndex(this.sel - 1, this.items().length);
      this.app.redraw();
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.sel = wrapIndex(this.sel + 1, this.items().length);
      this.app.redraw();
      return true;
    }
    return true;
  }
};
var JobsPanel = class _JobsPanel extends Popup {
  constructor(app) {
    const jobs = app.jobs ?? [];
    const w = Math.max(30, Math.min(110, app.screen.w - 4));
    const h = Math.max(10, Math.min(34, app.screen.h - 4));
    super({
      x: Math.max(0, Math.floor((app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor((app.screen.h - h) / 2)),
      w,
      h,
      title: "\u540E\u53F0\u6D3B\u52A8\uFF08Ctrl+J\uFF09",
      lines: [],
      buttons: [{ label: "\u5173\u95ED(q)", action: "close" }],
      onAction: () => app.closeOverlay(),
      scrollable: true
      // expanded details scroll instead of being clipped
    });
    this.app = app;
    this.page = "jobs";
    this.jobs = jobs;
    this.subagents = [];
    this.subagentError = null;
    this.expanded = /* @__PURE__ */ new Set();
    this.sel = 0;
    this.rowOf = [];
    this.rebuild();
    this.loadSubagents();
  }
  async loadSubagents() {
    if (!this.app.currentSession) return;
    try {
      const res = await this.app.api.call("subagent.list", { parentSessionId: this.app.currentSession });
      this.subagents = res.items ?? res.entries ?? [];
    } catch (e) {
      this.subagentError = e.message;
    }
    this.rebuild();
    this.app.redraw();
  }
  /** Width-aware character cut (no ellipsis — continuation chunks follow). */
  static #cutWidth(s, w) {
    let out = "", cw = 0;
    for (const ch of s) {
      const c = strWidth(ch);
      if (cw + c > w) break;
      out += ch;
      cw += c;
    }
    return out;
  }
  #detailLines(j) {
    const names = { label: "\u547D\u4EE4", detail: "\u7ED3\u679C", startedAt: "\u5F00\u59CB\u4E8E", finishedAt: "\u7ED3\u675F\u4E8E" };
    const fmtBeijing = (ms) => {
      if (typeof ms !== "number" || !isFinite(ms)) return String(ms ?? "");
      return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).replace("T", " ") + "\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09";
    };
    const lines = [];
    const budget = Math.max(20, this.w - 10);
    for (const [k, v] of Object.entries(j)) {
      if (["status", "kind"].includes(k)) continue;
      let s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      if (k === "startedAt" || k === "finishedAt") s = fmtBeijing(v);
      if (s === "") continue;
      const key = names[k] ?? k;
      let rest = s;
      let first = true;
      while (rest.length > 0 || first) {
        const head = first ? `${key}: ` : "     ";
        const take = _JobsPanel.#cutWidth(rest, budget - strWidth(head));
        lines.push([{ t: `      ${head}${take}`, fg: K.DIM }]);
        rest = rest.slice(take.length);
        first = false;
        if (lines.length > 200) break;
      }
    }
    return lines;
  }
  rebuild() {
    this.title = `\u540E\u53F0\u6D3B\u52A8 \xB7 ${this.page === "jobs" ? "\u4EFB\u52A1" : "\u5B50\u4EE3\u7406"}\uFF08Tab/\u2190\u2192 \u5207\u9875\uFF09`;
    let lines = [[{ t: ` [${this.page === "jobs" ? "\u4EFB\u52A1" : "\u4EFB\u52A1"}] [${this.page === "subagents" ? "\u5B50\u4EE3\u7406" : "\u5B50\u4EE3\u7406"}] \xB7 Tab/\u2190\u2192 \u5207\u9875 \xB7 \u2191\u2193\u9009\u62E9 \xB7 Enter\u5C55\u5F00 \xB7 q\u5173\u95ED`, fg: K.DIM }]];
    const rowOf = [-1];
    if (this.page === "subagents") {
      if (this.subagentError) {
        lines.push([{ t: ` \u5B50\u4EE3\u7406\u52A0\u8F7D\u5931\u8D25: ${this.subagentError}`, fg: K.ERR }]);
        rowOf.push(-1);
      }
      if (!this.subagents.length && !this.subagentError) {
        lines.push([{ t: " \uFF08\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u5B50\u4EE3\u7406\uFF09", fg: K.FAINT }]);
        rowOf.push(-1);
      }
      for (let i = 0; i < this.subagents.length; i++) {
        const child = this.subagents[i], bg = i === this.sel ? T.MENUSEL : T.BG2;
        const status = child.activity ?? child.status ?? child.mode ?? "idle";
        const open = this.expanded.has(i);
        lines.push([{ t: ` ${open ? "\u25BE" : "\u25B8"} \u25C7 ${truncate(child.label ?? child.sessionId ?? child.id ?? "\u5B50\u4EE3\u7406", 42)} `, fg: K.TXT, bg, bold: i === this.sel }, { t: status, fg: status === "running" ? K.WARN : K.DIM, bg }]);
        rowOf.push(i);
        if (this.expanded.has(i)) for (const [key, value] of Object.entries(child)) {
          lines.push([{ t: `      ${key}: ${truncate(typeof value === "object" ? JSON.stringify(value) : value, this.w - 16)}`, fg: K.DIM }]);
          rowOf.push(-1);
        }
      }
      this.lines = lines;
      this.rowOf = rowOf;
      this.#ensureVisible();
      return;
    }
    const jobs = this.jobs;
    if (jobs.length === 0) {
      lines.push([{ t: "  \uFF08\u5F53\u524D\u6CA1\u6709\u4EFB\u52A1\u5E27\uFF09", fg: K.FAINT }]);
      rowOf.push(-1);
    }
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const icon = j.status === "running" ? "\u2699" : j.status === "completed" ? "\u2713" : j.status === "failed" ? "\u2717" : "\xB7";
      const color = j.status === "running" ? K.WARN : j.status === "completed" ? K.OK : j.status === "failed" ? K.ERR : K.DIM;
      const open = this.expanded.has(i);
      const bg = i === this.sel ? T.MENUSEL : T.BG2;
      lines.push([
        { t: ` ${open ? "\u25BE" : "\u25B8"} ${icon} ${truncate(j.kind, 14)}`, fg: color, bold: true, bg },
        { t: ` ${truncate(j.label, 36)}`, fg: K.TXT, bg },
        { t: ` ${j.status}`, fg: K.DIM, bg }
      ]);
      rowOf.push(i);
      if (open) for (const fl of this.#detailLines(j)) {
        lines.push(fl);
        rowOf.push(-1);
      }
    }
    this.lines = lines;
    this.rowOf = rowOf;
    this.#ensureVisible();
  }
  /** Keep the selected job row inside the scrollable viewport. */
  #ensureVisible() {
    const avail = this.contentRows();
    const row = this.rowOf.findIndex((r) => r === this.sel);
    if (row < 0) return;
    if (row < this.scrollY) this.scrollY = row;
    else if (row >= this.scrollY + avail) this.scrollY = row - avail + 1;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
  }
  #toggle(i) {
    if (this.expanded.has(i)) this.expanded.delete(i);
    else this.expanded.add(i);
    this.rebuild();
    this.app.redraw();
  }
  onKey(ev) {
    if (ev.type === "key") {
      if (ev.name === "escape" || ev.name === "char" && ev.key === "q" && !ev.ctrl) {
        this.app.closeOverlay();
        return true;
      }
      if (ev.name === "tab" || ev.name === "backtab" || ev.name === "left" || ev.name === "right") {
        this.page = this.page === "jobs" ? "subagents" : "jobs";
        this.sel = 0;
        this.expanded.clear();
        this.scrollY = 0;
        this.rebuild();
        return true;
      }
      const current2 = this.page === "jobs" ? this.jobs : this.subagents;
      if (current2.length === 0) return super.onKey(ev);
      if (ev.name === "up" || ev.name === "char" && ev.key === "k" && !ev.ctrl) {
        this.sel = wrapIndex(this.sel - 1, current2.length);
        this.rebuild();
        return true;
      }
      if (ev.name === "down" || ev.name === "char" && ev.key === "j" && !ev.ctrl) {
        this.sel = wrapIndex(this.sel + 1, current2.length);
        this.rebuild();
        return true;
      }
      if (ev.name === "enter" || ev.name === "char" && ev.key === "l" && !ev.ctrl) {
        if (current2[this.sel]) {
          if (this.expanded.has(this.sel)) this.expanded.delete(this.sel);
          else this.expanded.add(this.sel);
          this.rebuild();
        }
        return true;
      }
      if (ev.name === "char" && ev.key === "h" && !ev.ctrl) {
        this.expanded.delete(this.sel);
        this.rebuild();
        return true;
      }
    }
    return super.onKey(ev);
  }
  onMouse(ev) {
    if (super.onMouse(ev)) return true;
    if (ev.kind === "press" && ev.button === 0) {
      const i = ev.y - this.y - 1;
      const jIdx = this.rowOf[i];
      if (jIdx >= 0) {
        this.sel = jIdx;
        this.#toggle(jIdx);
        return true;
      }
      return true;
    }
    return false;
  }
};
var QueuePanel = class extends Popup {
  constructor(app) {
    const items = app.queueItems ?? [];
    const w = Math.max(24, Math.min(84, app.screen.w - 4));
    const h = Math.max(7, Math.min(24, app.screen.h - 4));
    super({
      x: Math.max(0, Math.floor((app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor((app.screen.h - h) / 2)),
      w,
      h,
      title: "\u6392\u961F\u547D\u4EE4 \xB7 j/k \u9009\u62E9 \xB7 Enter \u5C55\u5F00 \xB7 PgUp/PgDn \u6EDA\u52A8 \xB7 ? \u5E2E\u52A9",
      lines: [],
      buttons: [],
      scrollable: true
    });
    this.app = app;
    this.items = items;
    this.sel = 0;
    this.pending = false;
    this.dArmed = false;
    this.helpVisible = false;
    this.expanded = /* @__PURE__ */ new Set();
    this.rowOf = [];
    this.rebuild();
  }
  #itemKey(item, index = this.items.indexOf(item)) {
    return String(item?.id ?? item?.message?.id ?? `${item?.placement ?? "queue"}:${index}:${partsText(item?.message?.content).slice(0, 80)}`);
  }
  #wrap(label, value, fg = K.TXT) {
    const rows = [];
    const firstHead = `    ${label}: `;
    const nextHead = " ".repeat(strWidth(firstHead));
    const width = Math.max(8, this.w - 4 - strWidth(firstHead));
    let first = true;
    for (const raw of String(value ?? "").split("\n")) {
      if (raw === "") {
        rows.push([{ t: first ? firstHead : nextHead, fg: K.DIM }]);
        first = false;
        continue;
      }
      let line = "", used = 0;
      for (const ch of graphemes(raw)) {
        const cw = graphemeWidth(ch);
        if (line && used + cw > width) {
          rows.push([{ t: first ? firstHead : nextHead, fg: K.DIM }, { t: line, fg }]);
          first = false;
          line = "";
          used = 0;
        }
        line += ch;
        used += cw;
      }
      rows.push([{ t: first ? firstHead : nextHead, fg: K.DIM }, { t: line, fg }]);
      first = false;
      if (rows.length >= 180) break;
    }
    return rows;
  }
  #content(item) {
    const texts = [], extras = [];
    const walk = (content) => {
      if (typeof content === "string") {
        texts.push(content);
        return;
      }
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
        else {
          const identity = part.name ?? part.fileName ?? part.attachmentId ?? part.id ?? part.mediaType ?? part.url ?? "";
          extras.push(`[${part.type ?? "\u5185\u5BB9"}]${identity ? ` ${identity}` : ""}`);
        }
        if (Array.isArray(part.content)) walk(part.content);
      }
    };
    walk(item?.message?.content);
    return { text: texts.join("\n"), extras };
  }
  #detailLines(item) {
    const lines = [];
    const placement = item.placement === "queued" ? "\u6392\u961F\uFF08\u4E0B\u4E00\u56DE\u5408\uFF09" : item.placement === "steering" ? "\u8FFD\u52A0\u5230\u5F53\u524D\u56DE\u5408" : item.placement === "context" ? "\u53EA\u8BFB\u4E0A\u4E0B\u6587" : item.placement ?? "\u672A\u77E5";
    lines.push(...this.#wrap("ID", item.id ?? "\uFF08\u65E0\uFF09", K.DIM));
    lines.push(...this.#wrap("\u4F4D\u7F6E", placement, K.DIM));
    const source = item.message?.source?.kind ?? item.source?.kind;
    if (source) lines.push(...this.#wrap("\u6765\u6E90", source, K.DIM));
    for (const key of ["createdAt", "updatedAt", "clientTimeZone"]) {
      if (item[key] != null) lines.push(...this.#wrap(key, item[key], K.DIM));
    }
    const content = this.#content(item);
    lines.push(...this.#wrap("\u5185\u5BB9", content.text || "\uFF08\u65E0\u6587\u672C\u5185\u5BB9\uFF09"));
    for (const extra of content.extras) lines.push(...this.#wrap("\u9644\u4EF6", extra, K.ACCENT));
    if (lines.length > 200) return [...lines.slice(0, 200), [{ t: "    \u2026\u8BE6\u60C5\u8D85\u8FC7 200 \u884C\uFF0C\u5DF2\u622A\u65AD", fg: K.FAINT }]];
    return lines;
  }
  rebuild() {
    const lines = [], rowOf = [];
    if (this.helpVisible) {
      for (const text of [
        " \u952E\u76D8\u4F18\u5148\uFF1Aj/k \u6216 \u2191/\u2193 \u9009\u62E9\u547D\u4EE4\uFF1BEnter/\u2192/l \u5C55\u5F00\uFF1B\u2190/h \u6298\u53E0",
        " PgUp/PgDn \u6216 Ctrl+B/F \u6574\u9875\u6EDA\u52A8\uFF1BCtrl+U/D \u534A\u9875\u6EDA\u52A8",
        " Ctrl+Y/E \u6216 Shift+\u2191/\u2193 \u9010\u884C\u6EDA\u52A8\uFF1BHome/End \u5230\u8BE6\u60C5\u9996\u5C3E",
        " dd \u5220\u9664\u5F53\u524D\u547D\u4EE4\uFF1B? \u9690\u85CF\u5E2E\u52A9\uFF1Bq/Esc \u5173\u95ED"
      ]) {
        lines.push([{ t: text, fg: K.DIM }]);
        rowOf.push(-1);
      }
      lines.push([{ t: "" }]);
      rowOf.push(-1);
    }
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const key = this.#itemKey(item, i);
      const open = this.expanded.has(key);
      const selected = i === this.sel;
      const text = partsText(item.message?.content).replace(/\s+/g, " ");
      const placement = item.placement === "queued" ? "\u23F3" : item.placement === "steering" ? "\u21AA" : "\u2139";
      lines.push([{
        t: `${selected ? "\u25B8" : " "} ${open ? "\u25BE" : "\u25B8"} ${placement} ${truncate(text || item.id, this.w - 10)}`,
        fg: selected ? T.SELFG : K.TXT,
        bg: selected ? T.MENUSEL : -1,
        bold: selected
      }]);
      rowOf.push(i);
      if (open) {
        for (const line of this.#detailLines(item)) {
          lines.push(line.map((seg) => ({ ...seg, bg: selected ? T.MENUSEL : seg.bg })));
          rowOf.push(i);
        }
      }
    }
    if (!this.items.length) {
      lines.push([{ t: " \uFF08\u961F\u5217\u4E3A\u7A7A\uFF09", fg: K.FAINT }]);
      rowOf.push(-1);
    }
    this.lines = lines;
    this.rowOf = rowOf;
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
  }
  #ensureSelected() {
    const row = this.rowOf.findIndex((idx) => idx === this.sel);
    if (row < 0) return;
    if (row < this.scrollY) this.scrollY = row;
    else if (row >= this.scrollY + this.contentRows()) this.scrollY = Math.max(0, row - this.contentRows() + 1);
  }
  /** Detail scrolling is intentionally independent from queue selection.
   * j/k chooses a command; these operations move only the viewport. */
  #scrollBy(delta) {
    this.dArmed = false;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + delta));
    this.app.redraw();
    return true;
  }
  #scrollTo(position) {
    this.dArmed = false;
    this.scrollY = position === "end" ? this.maxScroll() : 0;
    this.app.redraw();
    return true;
  }
  #toggle(index = this.sel) {
    const item = this.items[index];
    if (!item) return;
    const key = this.#itemKey(item, index);
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.rebuild();
    this.#ensureSelected();
    this.app.redraw();
  }
  syncItems(items) {
    const selectedId = this.items[this.sel]?.id;
    this.items = items ?? [];
    const live = new Set(this.items.map((item, i) => this.#itemKey(item, i)));
    for (const key of [...this.expanded]) if (!live.has(key)) this.expanded.delete(key);
    const next = selectedId ? this.items.findIndex((item) => item.id === selectedId) : -1;
    this.sel = next >= 0 ? next : Math.min(this.sel, Math.max(0, this.items.length - 1));
    this.rebuild();
    this.#ensureSelected();
  }
  #errorCode(error) {
    return error?.code ?? error?.details?.code ?? error?.cause?.code;
  }
  async #mutate(kind, content) {
    const item = this.items[this.sel];
    if (this.pending) {
      this.app.toast("\u961F\u5217\u64CD\u4F5C\u6B63\u5728\u8FDB\u884C");
      return;
    }
    if (!item || item.placement === "context") {
      this.app.toast("\u8BE5\u6761\u76EE\u4E3A\u53EA\u8BFB\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u80FD\u4FEE\u6539");
      return;
    }
    this.pending = true;
    this.rebuild();
    this.app.redraw();
    try {
      const action = kind === "edit" ? { kind, content: [{ type: "text", text: content }] } : { kind };
      await this.app.api.call("session.updateQueue", { sessionId: this.app.currentSession, itemId: item.id, action });
      if (kind === "remove") this.syncItems(this.items.filter((row) => row.id !== item.id));
    } catch (e) {
      const code = this.#errorCode(e);
      if (code === "queue-item-not-found" || /queue-item-not-found/.test(e.message ?? "")) {
        this.syncItems(this.items.filter((row) => row.id !== item.id));
        this.app.toast("\u961F\u5217\u5DF2\u7531\u5176\u4ED6\u5BA2\u6237\u7AEF\u66F4\u65B0\uFF0C\u8BE5\u6761\u76EE\u5DF2\u79FB\u9664");
      } else if (code === "steer-unavailable" || /steer-unavailable/.test(e.message ?? "")) {
        this.app.toast("\u5F53\u524D\u56DE\u5408 steering \u7A97\u53E3\u5DF2\u5173\u95ED\uFF0C\u6D88\u606F\u4ECD\u4FDD\u7559\u5728\u961F\u5217\u4E2D");
      } else this.app.toast(`\u961F\u5217\u64CD\u4F5C\u5931\u8D25: ${e.message}`);
    } finally {
      this.pending = false;
      this.rebuild();
      this.app.redraw();
    }
  }
  onKey(ev) {
    const ch = ev.type === "text" ? ev.text : ev.type === "key" && ev.name === "char" ? ev.key : null;
    const plain = !ev.ctrl && !ev.alt && !ev.shift;
    if (plain && ch === "q") {
      this.app.closeOverlay();
      return true;
    }
    if (!ev.ctrl && !ev.alt && ch === "?") {
      this.helpVisible = !this.helpVisible;
      this.dArmed = false;
      this.rebuild();
      this.scrollY = 0;
      this.app.redraw();
      return true;
    }
    if (plain && ch === "d") {
      if (this.dArmed) {
        this.dArmed = false;
        this.#mutate("remove");
      } else {
        this.dArmed = true;
        this.app.toast("\u518D\u6309 d \u5220\u9664\u8FD9\u6761\u6392\u961F\u547D\u4EE4");
      }
      return true;
    }
    if (ev.type === "key") {
      if (ev.name === "escape") {
        this.app.closeOverlay();
        return true;
      }
      if (ev.name === "pgup" || ev.ctrl && ev.key === "b") return this.#scrollBy(-this.contentRows());
      if (ev.name === "pgdn" || ev.ctrl && ev.key === "f") return this.#scrollBy(this.contentRows());
      if (ev.ctrl && ev.key === "u") return this.#scrollBy(-Math.max(1, Math.floor(this.contentRows() / 2)));
      if (ev.ctrl && ev.key === "d") return this.#scrollBy(Math.max(1, Math.floor(this.contentRows() / 2)));
      if (ev.ctrl && ev.key === "y" || ev.name === "up" && ev.shift) return this.#scrollBy(-1);
      if (ev.ctrl && ev.key === "e" || ev.name === "down" && ev.shift) return this.#scrollBy(1);
      if (ev.name === "home") return this.#scrollTo("home");
      if (ev.name === "end") return this.#scrollTo("end");
      if (ev.name === "enter" || ev.name === "right" || ev.name === "char" && ev.key === "l" && plain) {
        this.dArmed = false;
        this.#toggle();
        return true;
      }
      if (ev.name === "left" || ev.name === "char" && ev.key === "h" && plain) {
        this.dArmed = false;
        const item = this.items[this.sel], key = this.#itemKey(item, this.sel);
        if (item && this.expanded.delete(key)) {
          this.rebuild();
          this.#ensureSelected();
          this.app.redraw();
        }
        return true;
      }
      if (ev.name === "up" && !ev.shift || ev.name === "char" && ev.key === "k" && plain) {
        this.dArmed = false;
        this.sel = wrapIndex(this.sel - 1, this.items.length);
        this.rebuild();
        this.#ensureSelected();
        return true;
      }
      if (ev.name === "down" && !ev.shift || ev.name === "char" && ev.key === "j" && plain) {
        this.dArmed = false;
        this.sel = wrapIndex(this.sel + 1, this.items.length);
        this.rebuild();
        this.#ensureSelected();
        return true;
      }
    }
    this.dArmed = false;
    return false;
  }
  onMouse(ev) {
    if (super.onMouse(ev)) return true;
    if (ev.kind === "press" && ev.button === 0) {
      const row = ev.y - this.y - 1 + this.scrollY;
      const idx = this.rowOf[row];
      if (idx >= 0) {
        this.sel = idx;
        this.#toggle(idx);
        return true;
      }
    }
    return false;
  }
};
var GoalPanel = class extends Popup {
  constructor(app) {
    super({ x: 4, y: 2, w: Math.max(24, Math.min(84, app.screen.w - 8)), h: Math.max(10, Math.min(28, app.screen.h - 4)), title: "\u76EE\u6807\u4E0E\u4EFB\u52A1", lines: [], buttons: [], scrollable: true });
    this.app = app;
    this.busy = false;
    this.actionSel = 0;
    this.actions = [];
    this.actionRows = [];
    this.rebuild();
  }
  /** Called by App when a live goal/todo projection arrives while open. */
  sync() {
    this.rebuild();
    this.app.redraw();
  }
  get goal() {
    return this.app.goalData?.goal ?? this.app.goalData;
  }
  #ref() {
    const g = this.goal;
    return g?.id && g?.revision != null ? { id: g.id, revision: g.revision } : null;
  }
  rebuild() {
    const goal = this.goal, todos = this.app.todos ?? [], lines = [];
    lines.push([{ t: " \u2191\u2193 \u9009\u62E9\u64CD\u4F5C \xB7 Enter \u6253\u5F00 \xB7 Esc \u5173\u95ED\uFF08\u5B8C\u6210/\u6E05\u9664\u4F1A\u518D\u6B21\u786E\u8BA4\uFF09", fg: this.busy ? K.WARN : K.DIM }]);
    if (!goal) lines.push([{ t: " \u5F53\u524D\u6CA1\u6709\u81EA\u52A8\u6301\u7EED\u76EE\u6807\u3002\u5B83\u7528\u4E8E\u9700\u8981\u8DE8\u591A\u8F6E\u81EA\u52A8\u63A8\u8FDB\u7684\u957F\u671F\u4EFB\u52A1\uFF1B\u666E\u901A\u5BF9\u8BDD\u65E0\u9700\u521B\u5EFA\u3002", fg: K.FAINT }]);
    else {
      lines.push([{ t: ` \u76EE\u6807: ${goal.objective ?? goal}`, fg: K.TXT, bold: true }]);
      lines.push([{ t: ` \u9636\u6BB5: ${goal.phase ?? "active"} \xB7 \u8F6E\u6B21 ${this.app.goalData?.roundsStarted ?? 0}/${goal.maxGoalRounds ?? "\u221E"} \xB7 \u4FEE\u8BA2 ${goal.revision ?? "?"}`, fg: K.DIM }]);
      if (goal.blockedReason?.message) lines.push([{ t: ` \u963B\u585E: ${goal.blockedReason.message}`, fg: K.ERR }]);
    }
    this.actions = goal ? [
      { label: "\u7F16\u8F91\u76EE\u6807", run: () => this.#edit("objective") },
      { label: "\u4FEE\u6539\u6700\u5927\u8F6E\u6B21", run: () => this.#edit("maxGoalRounds") },
      { label: goal.phase === "active" ? "\u6682\u505C\u81EA\u52A8\u7EE7\u7EED" : "\u7EE7\u7EED\u76EE\u6807", run: () => this.#call(goal.phase === "active" ? "goal.pause" : "goal.resume", { ref: this.#ref() }) },
      { label: "\u5B8C\u6210\u76EE\u6807\u2026", danger: true, run: () => this.#confirm("\u786E\u8BA4\u5B8C\u6210\u5F53\u524D\u76EE\u6807\uFF1F", "goal.complete") },
      { label: "\u6E05\u9664\u76EE\u6807\u2026", danger: true, run: () => this.#confirm("\u786E\u8BA4\u6E05\u9664\u5F53\u524D\u76EE\u6807\uFF1F\u5386\u53F2\u4F1A\u4FDD\u7559 tombstone\u3002", "goal.clear") }
    ] : [{ label: "\u521B\u5EFA\u81EA\u52A8\u6301\u7EED\u76EE\u6807\u2026", run: () => this.#edit("objective") }];
    this.actionSel = Math.min(this.actionSel, this.actions.length - 1);
    lines.push([{ t: "" }, { t: " \u64CD\u4F5C", fg: K.ACCENT, bold: true }]);
    this.actionRows = [];
    for (let i = 0; i < this.actions.length; i++) {
      const action = this.actions[i], selected = i === this.actionSel;
      this.actionRows[i] = lines.length;
      lines.push([{ t: ` ${selected ? "\u25B8" : " "} ${action.label}`, fg: action.danger ? K.ERR : selected ? T.SELFG : K.TXT, bg: selected ? T.MENUSEL : -1, bold: selected }]);
    }
    lines.push([{ t: "" }, { t: ` \u4EFB\u52A1\u6E05\u5355\uFF08${todos.filter((t) => t.status === "completed").length}/${todos.length}\uFF09`, fg: K.ACCENT, bold: true }]);
    for (const todo of todos) {
      const icon = todo.status === "completed" ? "\u2713" : todo.status === "in_progress" ? "\u25C9" : "\u25CB";
      lines.push([{ t: `  ${icon} ${truncate(todo.content, this.w - 8)}`, fg: todo.status === "completed" ? K.OK : todo.status === "in_progress" ? K.WARN : K.DIM }]);
    }
    if (!todos.length) lines.push([{ t: "  \uFF08\u6CA1\u6709\u4EFB\u52A1\uFF09", fg: K.FAINT }]);
    this.lines = lines;
  }
  async #call(method, payload) {
    if (this.busy) return;
    this.busy = true;
    this.rebuild();
    this.app.redraw();
    try {
      await this.app.api.call(method, { sessionId: this.app.currentSession, ...payload });
      this.app.toast("\u76EE\u6807\u5DF2\u66F4\u65B0\uFF0C\u6B63\u5728\u540C\u6B65\u2026");
    } catch (e) {
      const conflict = e?.code === "goal-revision-conflict" || /revision|conflict|stale/i.test(e?.message ?? "");
      this.app.toast(conflict ? "\u76EE\u6807\u5DF2\u88AB\u5176\u4ED6\u5BA2\u6237\u7AEF\u66F4\u65B0\uFF0C\u8BF7\u5173\u95ED\u540E\u91CD\u65B0\u6253\u5F00" : `\u76EE\u6807\u64CD\u4F5C\u5931\u8D25: ${e.message}`);
    } finally {
      this.busy = false;
      this.rebuild();
      this.app.redraw();
    }
  }
  #confirm(message, method) {
    const confirm = new Popup({ x: Math.max(0, this.x + 6), y: Math.max(0, this.y + 4), w: Math.max(24, Math.min(64, this.w - 12)), h: 7, title: "\u786E\u8BA4\u76EE\u6807\u64CD\u4F5C", lines: [[{ t: " " + message, fg: K.WARN }]], buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u786E\u8BA4", action: "confirm" }], onAction: (button) => {
      this.app.overlay = this;
      if (button.action === "confirm") this.#call(method, { ref: this.#ref() });
      else this.app.redraw();
    } });
    this.app.overlay = confirm;
    this.app.redraw();
  }
  #edit(field) {
    const goal = this.goal;
    const creating = !goal;
    const value = field === "maxGoalRounds" ? String(goal?.maxGoalRounds ?? "") : String(goal?.objective ?? "");
    const popup = new EditPopup(this.app, {
      title: creating ? "\u521B\u5EFA\u81EA\u52A8\u6301\u7EED\u76EE\u6807\uFF08\u957F\u671F\u4EFB\u52A1\uFF09" : field === "maxGoalRounds" ? "\u4FEE\u6539\u6700\u5927\u8F6E\u6B21" : "\u7F16\u8F91\u76EE\u6807",
      value,
      placeholder: field === "maxGoalRounds" ? "\u6B63\u6574\u6570\uFF0C\u7559\u7A7A\u4FDD\u6301\u4E0D\u53D8" : "\u8F93\u5165\u76EE\u6807\u2026",
      onCommit: (text) => {
        this.app.overlay = this;
        if (field === "maxGoalRounds") {
          const n = Number(text.trim());
          if (!Number.isSafeInteger(n) || n <= 0) {
            this.app.toast("\u6700\u5927\u8F6E\u6B21\u5FC5\u987B\u662F\u6B63\u6574\u6570");
            return;
          }
          this.#call("goal.edit", { ref: this.#ref(), maxGoalRounds: n });
        } else if (creating) {
          if (!text.trim()) {
            this.app.toast("\u76EE\u6807\u4E0D\u80FD\u4E3A\u7A7A");
            return;
          }
          this.#call("goal.create", { objective: text.trim() });
        } else this.#call("goal.edit", { ref: this.#ref(), objective: text.trim() });
      }
    });
    this.app.overlay = popup;
    this.app.focus(popup.input);
    this.app.redraw();
  }
  onKey(ev) {
    if (ev.type === "key") {
      if (ev.name === "escape") {
        this.app.closeOverlay();
        return true;
      }
      if (ev.name === "up") {
        this.actionSel = wrapIndex(this.actionSel - 1, this.actions.length);
        this.rebuild();
        return true;
      }
      if (ev.name === "down") {
        this.actionSel = wrapIndex(this.actionSel + 1, this.actions.length);
        this.rebuild();
        return true;
      }
      if (ev.name === "enter") {
        this.actions[this.actionSel]?.run();
        return true;
      }
    }
    return super.onKey(ev);
  }
  onMouse(ev) {
    if (ev.kind === "press" && ev.button === 0) {
      const line = ev.y - this.y - 1 + this.scrollY;
      const idx = this.actionRows.indexOf(line);
      if (idx >= 0) {
        this.actionSel = idx;
        this.rebuild();
        this.actions[idx]?.run();
        return true;
      }
    }
    return super.onMouse(ev);
  }
};
function buildGoalPopup(app) {
  return new GoalPanel(app);
}
var TYPE_COLORS = new Proxy({}, {
  get(_t, key) {
    const map = { string: "STRING", number: "NUMBER", boolean: "LINK", object: "DIM", array: "DIM", null: "FAINT" };
    return T[map[key] ?? key];
  }
});
var SettingsPanel = class extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.namespaces = [];
    this.nsIdx = 0;
    this.rows = [];
    this.pendingOps = [];
    this.editing = false;
    this.editPath = null;
    this.secrets = /* @__PURE__ */ new Set();
    const listW = 26;
    this.nsList = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: this.h - 2, showScrollbar: true });
    this.tree = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: this.w - listW - 2, h: this.h - 3, showScrollbar: true });
    this.input = new Input({ x: this.x + listW + 1, y: this.y + this.h - 2, w: this.w - listW - 2, h: 1, prompt: "\u503C: ", placeholder: "\u8F93\u5165\u65B0\u503C\uFF0CEnter \u6682\u5B58\uFF0CEsc \u53D6\u6D88" });
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    const listW = 26;
    this.nsList.x = x + 1;
    this.nsList.y = y + 1;
    this.nsList.w = listW;
    this.nsList.h = h - 2;
    this.tree.x = x + listW + 1;
    this.tree.y = y + 1;
    this.tree.w = w - listW - 2;
    this.tree.h = h - 3;
    this.input.x = x + listW + 1;
    this.input.y = y + h - 2;
    this.input.w = w - listW - 2;
  }
  async load() {
    try {
      const d = await this.app.api.call("settings.describe");
      this.namespaces = d.namespaces ?? [];
      this.writable = d.writable;
    } catch (e) {
      this.app.toast(`\u8BBE\u7F6E\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
      return;
    }
    this.namespaces.unshift({
      ns: "TUI \u754C\u9762",
      applies: "live",
      local: true,
      value: { userPrefix: userName() }
    });
    const fd = foldDefaults();
    this.namespaces.splice(1, 0, {
      ns: "\u9ED8\u8BA4\u5C55\u5F00/\u6298\u53E0",
      applies: "live",
      local: true,
      value: { \u601D\u8003\u5757\u9ED8\u8BA4\u5C55\u5F00: fd.think, \u5DE5\u5177\u5757\u9ED8\u8BA4\u5C55\u5F00: fd.bash, \u4EFB\u52A1\u6E05\u5355\u9ED8\u8BA4\u663E\u793A: fd.todos }
    });
    this.namespaces.splice(2, 0, {
      ns: "\u6A21\u578B\u4F9B\u5E94\u5546\u2026",
      applies: "live",
      local: true,
      modelsEntry: true,
      value: {}
    });
    this.selectNs(0);
  }
  selectNs(i) {
    this.nsIdx = Math.max(0, Math.min(this.namespaces.length - 1, i));
    this.pendingOps = [];
    this.editing = false;
    const ns = this.namespaces[this.nsIdx];
    if (ns.modelsEntry) {
      this.app.showModelsBuffer ? this.app.showModelsBuffer() : this.app.setMode?.("models");
      return;
    }
    this.secrets = new Set((ns.secrets ?? []).map((s) => JSON.stringify(s.path ?? [])));
    this.rebuildRows();
    const items = this.namespaces.map((n) => ({
      text: n.ns,
      sub: n.applies === "live" ? "live" : "\u91CD\u542F\u751F\u6548",
      badge: n.applies === "live" ? "" : "\u21BB",
      data: n
    }));
    this.nsList.setLines(items.map((it) => it.lines ?? this.nsRow(it)));
    this.nsItems = items;
    this.app.redraw();
  }
  nsRow(it) {
    return [{ t: `${it.badge ? it.badge + " " : ""}${truncate(it.text, 20)}`, fg: 13949149, bold: false }, { t: " " + it.sub, fg: 9147294 }];
  }
  rebuildRows() {
    const ns = this.namespaces[this.nsIdx];
    if (!ns) {
      this.rows = [];
      this.tree.setLines([]);
      return;
    }
    const value = applyOps(ns.value, this.pendingOps);
    const rows = [];
    flattenJson(value, [], rows);
    this.rows = rows;
    this.tree.setLines(rows.map((r) => this.rowLine(r)));
  }
  rowLine(r) {
    const p = r.path.join(".");
    const vt = typeof r.value;
    let v;
    if (r.value === null) v = "null";
    else if (vt === "object") v = Array.isArray(r.value) ? `[${Object.keys(r.value).length}]` : `{${Object.keys(r.value).length}}`;
    else v = String(r.value);
    if (this.secrets.has(JSON.stringify(r.path))) v = "\u2022\u2022\u2022\u2022\u2022";
    const segs = [{ t: p, fg: K.TXT }];
    if (!(vt === "object" && r.value !== null)) segs.push({ t: " = ", fg: K.FAINT }, { t: v, fg: TYPE_COLORS[vt] ?? K.TXT, bold: vt !== "string" });
    return segs;
  }
  currentNs() {
    return this.namespaces[this.nsIdx];
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.x + 26;
    screen.vline(mid, this.y, this.y + this.h - 1, "\u2502", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " \u8BBE\u7F6E \u2014 \u70B9\u51FB\u503C\u7F16\u8F91\uFF0CCtrl+S \u4FDD\u5B58\uFF0CEsc \u8FD4\u56DE", { fg: K.DIM });
    this.nsList.render(screen);
    const ns = this.currentNs();
    if (ns) {
      const revTag = ns.local ? "" : ` rev${ns.revision}`;
      screen.text(this.x + 28, this.y, ` ${ns.ns}${revTag}  ${this.writable === false && !ns.local ? "(\u53EA\u8BFB)" : ""}`, { fg: K.ACCENT, bold: true });
      const pend = this.pendingOps.length ? `  \u26A0 ${this.pendingOps.length} \u9879\u5F85\u4FDD\u5B58` : "";
      if (pend) screen.text(this.x + 28 + strWidth(` ${ns.ns}${revTag}  `), this.y, pend, { fg: K.WARN });
    }
    this.tree.render(screen);
    if (this.editing) {
      screen.hline(this.x + 27, this.x + this.w - 1, this.y + this.h - 3, "\u2500", { fg: 3818060 });
      screen.text(this.x + 28, this.y + this.h - 3, `\u7F16\u8F91 ${this.editPath.join(".")}`, { fg: K.WARN, bold: true });
      this.input.render(screen);
    }
  }
  onMouse(ev) {
    if (ev.x < this.x + 26) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.nsList.y + this.nsList.scrollY;
        if (idx >= 0 && idx < this.namespaces.length) {
          this.selectNs(idx);
          return true;
        }
      }
      return this.nsList.onMouse(ev);
    }
    if (this.editing && this.input.inside(ev.x, ev.y)) return this.input.onMouse(ev);
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.tree.scrollY + (ev.y - this.tree.y);
      const row = this.rows[idx];
      if (row) {
        if (typeof row.value === "boolean") {
          this.pendingOps.push({ op: "set", path: row.path, value: !row.value });
          this.rebuildRows();
          return true;
        }
        if (typeof row.value === "string" || typeof row.value === "number" || row.value === null) {
          this.editPath = row.path;
          this.editing = true;
          this.input.setValue(row.value === null ? "" : String(row.value), { select: row.value !== null });
          return true;
        }
        return false;
      }
    }
    return false;
  }
  onKey(ev) {
    if (this.editing) {
      if (ev.type === "key" && ev.name === "escape") {
        this.editing = false;
        this.rebuildRows();
        return true;
      }
      if (ev.type === "key" && ev.name === "enter") {
        const typed = this.input.value;
        this.pendingOps.push({ op: "set", path: this.editPath, value: parseScalar(typed) });
        this.editing = false;
        this.input.setValue("");
        this.rebuildRows();
        return true;
      }
      const handled = this.input.onKey(ev);
      if (handled) this.app.redraw();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
      return true;
    }
    if (ev.ctrl && ev.key === "s") {
      this.save();
      return true;
    }
    if (ev.name === "up" || ev.name === "down" || ev.name === "pgup" || ev.name === "pgdn") return this.tree.scroll(ev.name === "up" || ev.name === "pgup" ? -3 : 3);
    if (ev.name === "enter") {
      const idx = this.tree.scrollY;
      const row = this.rows[idx];
      if (row && (typeof row.value === "string" || typeof row.value === "number")) {
        this.editPath = row.path;
        this.editing = true;
        this.input.setValue(String(row.value), { select: true });
        return true;
      }
    }
    return false;
  }
  async save() {
    const ns = this.currentNs();
    if (!ns || this.pendingOps.length === 0) {
      this.app.toast("\u6CA1\u6709\u5F85\u4FDD\u5B58\u7684\u4FEE\u6539");
      return;
    }
    if (ns.local) {
      const v = applyOps(ns.value, this.pendingOps);
      if (ns.ns === "\u9ED8\u8BA4\u5C55\u5F00/\u6298\u53E0") {
        const patch = { foldDefaults: { think: !!v.\u601D\u8003\u5757\u9ED8\u8BA4\u5C55\u5F00, bash: !!v.\u5DE5\u5177\u5757\u9ED8\u8BA4\u5C55\u5F00, todos: !!v.\u4EFB\u52A1\u6E05\u5355\u9ED8\u8BA4\u663E\u793A } };
        if (saveTuiConfig(patch)) {
          this.pendingOps = [];
          this.app.toast("\u5DF2\u4FDD\u5B58\u5C55\u5F00/\u6298\u53E0\u9ED8\u8BA4\u503C\uFF08\u5373\u65F6\u751F\u6548\uFF09");
          const chat = this.app.chat;
          if (chat) {
            chat.thinkMode = v.\u601D\u8003\u5757\u9ED8\u8BA4\u5C55\u5F00 ? "expanded" : "collapsed";
            chat.bashMode = v.\u5DE5\u5177\u5757\u9ED8\u8BA4\u5C55\u5F00 ? "expanded" : "collapsed";
            chat.todosVisible = !!v.\u4EFB\u52A1\u6E05\u5355\u9ED8\u8BA4\u663E\u793A;
            chat.expanded.clear();
            chat.collapsedBlocks.clear();
            chat.queueRebuild();
          }
          await this.load();
        } else {
          this.app.toast("\u4FDD\u5B58\u5931\u8D25\uFF1A\u65E0\u6CD5\u5199\u5165 TUI \u914D\u7F6E\u6587\u4EF6");
        }
        return;
      }
      const name = String(v.userPrefix ?? "").trim();
      if (saveTuiConfig({ userPrefix: name })) {
        this.pendingOps = [];
        this.app.toast(name ? `\u5DF2\u4FDD\u5B58\u663E\u793A\u540D \u201C${name}\u201D\uFF08\u5373\u65F6\u751F\u6548\uFF09` : "\u5DF2\u6E05\u9664\u81EA\u5B9A\u4E49\u663E\u793A\u540D\uFF08\u56DE\u5230\u7CFB\u7EDF\u7528\u6237\u540D\uFF09");
        this.app.chat.cache.clear();
        this.app.chat.queueRebuild();
        await this.load();
      } else {
        this.app.toast("\u4FDD\u5B58\u5931\u8D25\uFF1A\u65E0\u6CD5\u5199\u5165 TUI \u914D\u7F6E\u6587\u4EF6");
      }
      return;
    }
    try {
      await this.app.api.call("settings.mutate", { ns: ns.ns, ops: this.pendingOps, expectedRevision: ns.revision });
      this.pendingOps = [];
      this.app.toast(`\u5DF2\u4FDD\u5B58 ${ns.ns}`);
      await this.load();
    } catch (e) {
      this.app.toast(`\u4FDD\u5B58\u5931\u8D25: ${e.message}`);
    }
  }
};
var EditPopup = class extends Popup {
  constructor(app, { title, value, onCommit, completions, masked, statusHint, placeholder }) {
    const w = Math.min(80, app.screen.w - 8);
    const h = Math.min(16, app.screen.h - 6);
    super({
      x: Math.floor((app.screen.w - w) / 2),
      y: Math.floor((app.screen.h - h) / 2),
      w,
      h,
      title,
      lines: [],
      buttons: [],
      onAction: () => {
      }
    });
    this.app = app;
    this.onCommit = onCommit;
    this.completions = completions ?? null;
    this.masked = masked ?? false;
    this.statusHint = statusHint ?? null;
    this.input = new Input({
      x: this.x + 2,
      y: this.y + h - 2,
      w: w - 4,
      h: 1,
      multi: true,
      maxLines: 4,
      app,
      masked: this.masked,
      prompt: "> ",
      placeholder: placeholder ?? (completions?.length ? "Tab \u8865\u5168\u5019\u9009 \xB7 Enter \u786E\u5B9A \xB7 Esc \u53D6\u6D88 \xB7 Ctrl+Shift+V \u7C98\u8D34" : "\u8F93\u5165\u503C\u2026\uFF08Ctrl+Shift+V \u7C98\u8D34,Enter \u786E\u5B9A,Esc \u53D6\u6D88\uFF09")
    });
    this.input.setValue(String(value ?? ""));
    this.#layout();
  }
  #layout() {
    const lines = [];
    if (this.statusHint) lines.push([{ t: " " + this.statusHint, fg: K.DIM }]);
    if (this.masked) {
      lines.push([{ t: " \u5DF2\u8F93\u5165:", fg: K.DIM, underline: true }]);
      const n = Array.from(this.input.value).length;
      lines.push(n === 0 ? [{ t: "\uFF08\u672A\u8F93\u5165 \u2014 \u7559\u7A7A\u4FDD\u6301\u73B0\u6709\u5BC6\u94A5\u4E0D\u53D8\uFF09", fg: K.FAINT }] : [{ t: " " + "\u2022".repeat(Math.min(n, 40)) + (n > 40 ? "\u2026" : ""), fg: K.TXT }, { t: `\uFF08${n} \u5B57\u7B26\uFF09`, fg: K.FAINT }]);
    } else {
      lines.push([{ t: " \u5F53\u524D\u503C\u9884\u89C8:", fg: K.DIM, underline: true }]);
      const v = this.input.value;
      if (v === "") lines.push([{ t: "\uFF08\u7A7A\uFF09", fg: K.FAINT }]);
      else for (const ln of v.split("\n").slice(0, 6)) lines.push([{ t: " " + truncate(ln, this.w - 6), fg: K.TXT }]);
    }
    if (this.completions?.length) {
      const v = this.input.value.trim();
      const segs = [{ t: " \u5019\u9009\u534F\u8BAE: ", fg: K.DIM }];
      this.completions.forEach((c, i) => {
        if (i > 0) segs.push({ t: " \xB7 ", fg: K.FAINT });
        segs.push({ t: c === v ? `\u2713${c}` : c, fg: c === v ? K.OK : v !== "" && c.startsWith(v) ? K.ACCENT : K.DIM, bold: c === v });
      });
      lines.push(segs);
    }
    lines.push([{ t: "" }]);
    this.lines = lines;
  }
  render(screen) {
    super.render(screen);
    this.input.render(screen);
  }
  onKey(ev) {
    if (ev.type === "key" && ev.name === "escape") {
      this.app.closeOverlay();
      this.app.focus(this.app.fullBuffer ?? this.app.chat);
      return true;
    }
    if (ev.type === "key" && ev.name === "tab" && this.completions?.length) {
      const v = this.input.value.trim();
      const all = this.completions;
      const i = all.indexOf(v);
      if (i >= 0) {
        this.input.setValue(all[(i + 1) % all.length]);
      } else {
        const m = all.find((c) => c.startsWith(v));
        if (m) this.input.setValue(m);
        else this.app.toast("\u6CA1\u6709\u5339\u914D\u7684\u5019\u9009\u534F\u8BAE");
      }
      this.#layout();
      this.app.redraw();
      return true;
    }
    if (ev.type === "key" && ev.name === "enter") {
      const v = this.input.value;
      this.app.closeOverlay();
      this.app.focus(this.app.fullBuffer ?? this.app.chat);
      this.onCommit?.(v);
      return true;
    }
    const handled = this.input.onKey(ev);
    if (handled) this.#layout();
    this.app.redraw();
    return true;
  }
  onMouse(ev) {
    if (this.input.inside(ev.x, ev.y)) {
      this.input.onMouse(ev);
      this.app.redraw();
      return true;
    }
    return super.onMouse(ev);
  }
};
var API_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var INPUT_MODALITIES = ["text", "image"];
var DEFAULT_INPUT_MODALITIES = ["text"];
var THINKING_FORMATS = ["openai", "deepseek", "openrouter", "together", "zai", "qwen", "string-thinking", "ant-ling"];
var ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var KEY_REF_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;
function deriveKeyRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
function inlineLabel(value) {
  return String(value ?? "").replace(/[\x00-\x1F\x7F]/g, "?");
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}
function withoutOwned(resolved, owned) {
  if (!isRecord(resolved)) return {};
  const result = {};
  const stored = isRecord(owned) ? owned : {};
  for (const [key, value] of Object.entries(resolved)) {
    if (!Object.hasOwn(stored, key)) result[key] = value;
    else if (isRecord(value) && isRecord(stored[key])) {
      const child = withoutOwned(value, stored[key]);
      if (Object.keys(child).length > 0) result[key] = child;
    }
  }
  return result;
}
function mergeConfig(inherited, draft) {
  const result = { ...isRecord(inherited) ? inherited : {} };
  for (const [key, value] of Object.entries(isRecord(draft) ? draft : {})) {
    result[key] = isRecord(value) && isRecord(result[key]) ? mergeConfig(result[key], value) : value;
  }
  return result;
}
function configAt(value, path) {
  let current2 = value;
  for (const key of path ?? []) {
    if (!isRecord(current2) && !Array.isArray(current2)) return void 0;
    current2 = current2[key];
  }
  return current2;
}
function profileOps(base, before, after) {
  const previous = isRecord(before) ? before : {};
  const next = isRecord(after) ? after : {};
  const ops = [];
  for (const [field, value] of Object.entries(next)) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(value)) ops.push({ op: "set", path: [...base, field], value });
  }
  for (const field of Object.keys(previous)) if (!(field in next)) ops.push({ op: "unset", path: [...base, field] });
  return ops;
}
function providerOps(before, after, wholeRoutes = /* @__PURE__ */ new Set()) {
  const ops = [];
  for (const [route, profile] of Object.entries(after)) {
    const previous = before[route];
    if (previous === void 0 && wholeRoutes.has(route)) {
      ops.push({ op: "set", path: ["providers", route], value: profile });
      continue;
    }
    const priorFields = previous ?? {};
    for (const [field, value] of Object.entries(profile)) {
      if (JSON.stringify(priorFields[field]) === JSON.stringify(value)) continue;
      ops.push({ op: "set", path: ["providers", route, field], value });
    }
    for (const field of Object.keys(priorFields)) {
      if (!(field in profile)) ops.push({ op: "unset", path: ["providers", route, field] });
    }
  }
  for (const route of Object.keys(before)) {
    if (!(route in after)) ops.push({ op: "unset", path: ["providers", route] });
  }
  return ops;
}
var ModelPanel = class extends Widget {
  constructor(app) {
    super({ x: Math.min(30, Math.max(0, app.screen.w - 1)), y: 0, w: Math.max(1, app.screen.w - 30), h: Math.max(1, app.screen.h - 1) });
    this.app = app;
    this.providers = {};
    this.resolvedProviders = {};
    this.inheritedProviders = {};
    this.baseProviders = {};
    this.directory = [];
    this.namespaceViews = /* @__PURE__ */ new Map();
    this.configuredDirectory = /* @__PURE__ */ new Set();
    this.initialConfiguredDirectory = /* @__PURE__ */ new Set();
    this.externalDrafts = /* @__PURE__ */ new Map();
    this.externalInherited = /* @__PURE__ */ new Map();
    this.externalUserConfigured = /* @__PURE__ */ new Set();
    this.externalSnapshots = /* @__PURE__ */ new Map();
    this.externalHostSnapshots = /* @__PURE__ */ new Map();
    this.revisions = /* @__PURE__ */ new Map();
    this.revision = 0;
    this.loaded = false;
    this.writable = true;
    this.routes = [];
    this.addMode = false;
    this.addItems = [];
    this.addCursor = 0;
    this.materializeRoutes = /* @__PURE__ */ new Set();
    this.sel = 0;
    this.mode = "list";
    this.formIdx = 0;
    this.formItems = [];
    this.modelsSel = -1;
    this.draftRoute = null;
    this.editing = null;
    this.sub = null;
    this.subItems = [];
    this.scanMode = false;
    this.scanItems = [];
    this.scanSel = /* @__PURE__ */ new Set();
    this.scanCursor = 0;
    this.scanning = false;
    this.savedSnapshot = "{}";
    this.hostSnapshot = "{}";
    this.keyStatus = {};
    this.pendingProbeKeys = /* @__PURE__ */ new Map();
    if (!(app.pendingModelCredentialCleanups instanceof Map)) {
      const savedCleanups = loadTuiConfig().pendingModelCredentialCleanups;
      app.pendingModelCredentialCleanups = new Map((Array.isArray(savedCleanups) ? savedCleanups : []).flatMap((item) => {
        const ref = typeof item?.ref === "string" ? item.ref : "";
        const route = typeof item?.route === "string" ? item.route : "";
        if (!route || ref !== deriveKeyRef(route)) return [];
        return [[ref, {
          route,
          error: typeof item.error === "string" ? item.error : "\u7B49\u5F85\u91CD\u8BD5",
          reconcile: item.reconcile === true
        }]];
      }));
    }
    this.pendingCredentialCleanups = app.pendingModelCredentialCleanups;
    this.formClickMap = [];
    const listW = Math.max(1, Math.min(26, this.w - 3));
    this.listView = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: Math.max(1, this.h - 2), showScrollbar: true });
    this.formView = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: Math.max(1, this.w - listW - 2), h: Math.max(1, this.h - 2), showScrollbar: true });
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    const listW = Math.max(1, Math.min(26, this.w - 3));
    this.listView.x = x + 1;
    this.listView.y = y + 1;
    this.listView.w = listW;
    this.listView.h = Math.max(1, this.h - 2);
    this.formView.x = x + listW + 1;
    this.formView.y = y + 1;
    this.formView.w = Math.max(1, this.w - listW - 2);
    this.formView.h = Math.max(1, this.h - 2);
  }
  async load() {
    if (this.loaded && this.#dirty()) {
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4ECD\u6709\u672A\u4FDD\u5B58\u4FEE\u6539");
      this.#rebuild();
      this.app.redraw();
      return;
    }
    this.pendingProbeKeys.clear();
    let described = false;
    let providerState = null;
    try {
      const [d, listing] = await Promise.all([
        this.app.api.call("settings.describe"),
        this.app.api.call("llm.providers").catch(() => ({ providers: [] }))
      ]);
      this.directory = (listing?.providers ?? []).filter((entry) => entry && typeof entry.provider === "string");
      this.namespaceViews = new Map((d.namespaces ?? []).map((view) => [view.ns, view]));
      this.revisions = new Map((d.namespaces ?? []).map((view) => [view.ns, view.revision ?? 0]));
      const ns = this.namespaceViews.get("llm-pi-ai");
      const hasLayerView = ns && (Object.hasOwn(ns, "user") || Object.hasOwn(ns, "base"));
      const configured = hasLayerView ? ns.user?.providers : ns?.value?.providers;
      this.providers = { ...configured ?? {} };
      this.resolvedProviders = { ...ns?.value?.providers ?? this.providers };
      this.baseProviders = { ...ns?.base?.providers ?? {} };
      this.inheritedProviders = Object.fromEntries(Object.entries(this.resolvedProviders).map(([route, profile]) => [
        route,
        mergeConfig(withoutOwned(profile, this.providers[route]), this.baseProviders[route])
      ]));
      this.configuredDirectory.clear();
      this.configuredDirectory = new Set(this.directory.filter((entry) => this.#configuredEntry(entry)).map((entry) => entry.provider));
      this.initialConfiguredDirectory = new Set(this.configuredDirectory);
      this.externalDrafts = /* @__PURE__ */ new Map();
      this.externalInherited = /* @__PURE__ */ new Map();
      this.externalUserConfigured = /* @__PURE__ */ new Set();
      this.externalSnapshots = /* @__PURE__ */ new Map();
      this.externalHostSnapshots = /* @__PURE__ */ new Map();
      for (const entry of this.directory) {
        if (entry.settingsNs === "llm-pi-ai") continue;
        const view = this.namespaceViews.get(entry.settingsNs);
        if (!view) continue;
        const stored = configAt(view.user, entry.settingsPath);
        if (stored !== void 0 && entry.settingsPath.length > 0) this.externalUserConfigured.add(entry.provider);
        const draft = cloneConfig(stored ?? {});
        const inherited = mergeConfig(withoutOwned(configAt(view.value, entry.settingsPath), stored), configAt(view.base, entry.settingsPath));
        const snapshot = JSON.stringify(draft);
        this.externalDrafts.set(entry.provider, draft);
        this.externalInherited.set(entry.provider, inherited);
        this.externalSnapshots.set(entry.provider, snapshot);
        this.externalHostSnapshots.set(entry.provider, snapshot);
      }
      this.revision = ns?.revision ?? 0;
      this.writable = d.writable !== false;
      this.materializeRoutes.clear();
      this.addMode = false;
      this.#syncRoutes();
      this.sel = Math.max(0, Math.min(this.sel, this.routes.length));
      providerState = this.#providerStateFromDescription(d);
      described = providerState !== null;
    } catch (e) {
      this.app.toast(`\u6A21\u578B\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
    }
    this.savedSnapshot = JSON.stringify(this.providers);
    this.hostSnapshot = this.savedSnapshot;
    const cleanup = described ? await this.#retryPendingCredentialCleanups({ notify: false, providerState }) : { completed: [], failed: [] };
    await this.#refreshKeys();
    if (cleanup.failed.length > 0) this.#showCredentialCleanupFailure(cleanup.failed[0]);
    else if (cleanup.completed.length > 0) this.app.toast(`\u5DF2\u6E05\u7406\u6258\u7BA1\u5BC6\u94A5 ${cleanup.completed.join("\u3001")}`);
    this.loaded = true;
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  #persistCredentialCleanups() {
    return saveTuiConfig({
      pendingModelCredentialCleanups: [...this.pendingCredentialCleanups].map(([ref, task]) => ({
        ref,
        route: task.route,
        error: task.error,
        ...task.reconcile ? { reconcile: true } : {}
      }))
    });
  }
  #providerStateFromDescription(description) {
    const ns = (description?.namespaces ?? []).find((item) => item.ns === "llm-pi-ai");
    if (!isRecord(ns?.value) || !isRecord(ns.value.providers)) return null;
    const providers = ns.value.providers;
    const routes = new Set(Object.keys(providers));
    const refs = new Set(Object.entries(providers).map(([route, profile]) => {
      const configured = isRecord(profile) && typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : "";
      return configured || deriveKeyRef(route);
    }));
    return { routes, refs };
  }
  #providerStateFromProfiles(providers) {
    return this.#providerStateFromDescription({ namespaces: [{ ns: "llm-pi-ai", value: { providers } }] });
  }
  #cleanupRouteReserved(route) {
    return [...this.pendingCredentialCleanups.values()].some((task) => task.route === route);
  }
  async #retryPendingCredentialCleanups({ onlyRef = null, notify = true, providerState = null } = {}) {
    const targets = [...this.pendingCredentialCleanups].filter(([ref]) => onlyRef === null || ref === onlyRef);
    if (targets.length === 0) return { completed: [], preserved: [], failed: [], persisted: true };
    const before = new Map([...this.pendingCredentialCleanups].map(([ref, task]) => [ref, { ...task }]));
    const completed = [], preserved = [], failed = [];
    let state = providerState;
    if (state === null) {
      try {
        state = this.#providerStateFromDescription(await this.app.api.call("settings.describe"));
        if (state === null) throw new Error("llm-pi-ai \u914D\u7F6E\u6682\u4E0D\u53EF\u7528");
      } catch (error) {
        const message = `\u65E0\u6CD5\u6838\u5BF9 Host \u6A21\u578B\u914D\u7F6E: ${String(error?.message ?? error).slice(0, 500)}`;
        for (const [ref, task] of targets) {
          const failure = { ref, route: task.route, error: message, reconcile: task.reconcile === true };
          this.pendingCredentialCleanups.set(ref, { route: task.route, error: message, reconcile: task.reconcile === true });
          failed.push(failure);
        }
      }
    }
    if (state !== null) {
      for (const [ref, task] of targets) {
        if (state.refs.has(ref)) {
          this.pendingCredentialCleanups.delete(ref);
          preserved.push(ref);
          continue;
        }
        if (task.reconcile && state.routes.has(task.route)) {
          const message = `\u8DEF\u7531 ${task.route} \u4ECD\u5B58\u5728\uFF0C\u65E0\u6CD5\u81EA\u52A8\u786E\u8BA4\u65E7\u5BC6\u94A5\u53EF\u6E05\u7406`;
          const failure = { ref, route: task.route, error: message, reconcile: true };
          this.pendingCredentialCleanups.set(ref, { route: task.route, error: message, reconcile: true });
          failed.push(failure);
          continue;
        }
        try {
          await this.app.api.call("credentials.unset", { ref });
          this.pendingCredentialCleanups.delete(ref);
          completed.push(ref);
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, 500);
          const failure = { ref, route: task.route, error: message };
          this.pendingCredentialCleanups.set(ref, { route: task.route, error: message });
          failed.push(failure);
        }
      }
    }
    const persisted = this.#persistCredentialCleanups();
    if (!persisted) {
      this.pendingCredentialCleanups.clear();
      for (const [ref, task] of before) this.pendingCredentialCleanups.set(ref, task);
      completed.length = 0;
      preserved.length = 0;
      failed.length = 0;
      for (const [ref, task] of targets) failed.push({
        ref,
        route: task.route,
        error: "\u5F85\u6E05\u7406\u5BC6\u94A5\u72B6\u6001\u65E0\u6CD5\u5199\u5165 tui-config.json",
        reconcile: task.reconcile === true
      });
    }
    if (notify) {
      if (failed.length > 0) this.app.toast(`\u6258\u7BA1\u5BC6\u94A5\u6E05\u7406\u5931\u8D25: ${failed[0].error}`);
      else if (completed.length > 0) this.app.toast(`\u5DF2\u6E05\u7406\u6258\u7BA1\u5BC6\u94A5 ${completed.join("\u3001")}`);
      else if (preserved.length > 0) this.app.toast(`\u51ED\u636E ${preserved.join("\u3001")} \u5DF2\u88AB\u65B0\u914D\u7F6E\u4F7F\u7528\uFF0C\u5DF2\u4FDD\u7559`);
    }
    return { completed, preserved, failed, persisted };
  }
  #showCredentialCleanupFailure(task) {
    const current2 = this.pendingCredentialCleanups.get(task.ref);
    if (!current2) return;
    const ref = task.ref;
    const error = current2.error || task.error || "\u672A\u77E5\u9519\u8BEF";
    const w = Math.max(30, Math.min(72, this.app.screen.w - 4));
    this.app.overlay = new Popup({
      x: Math.max(0, Math.floor((this.app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor(this.app.screen.h / 2) - 4),
      w,
      h: Math.min(9, this.app.screen.h),
      title: "\u6258\u7BA1\u5BC6\u94A5\u5F85\u6E05\u7406",
      lines: [
        [{ t: current2.reconcile ? ` \u4F9B\u5E94\u5546 ${inlineLabel(current2.route)} \u7684\u5220\u9664\u7ED3\u679C\u5F85\u6838\u5BF9\uFF0C${ref} \u6682\u4E0D\u6E05\u7406\u3002` : ` \u4F9B\u5E94\u5546 ${inlineLabel(current2.route)} \u5DF2\u5220\u9664\uFF0C\u4F46 ${ref} \u5C1A\u672A\u6E05\u7406\u3002`, fg: K.WARN }],
        [{ t: ` ${truncate(inlineLabel(error), w - 4)}`, fg: K.DIM }],
        [{ t: " \u53EF\u7ACB\u5373\u91CD\u8BD5\uFF1B\u4FDD\u7559\u5BC6\u94A5\u4F1A\u505C\u6B62\u540E\u7EED\u81EA\u52A8\u6E05\u7406\u3002", fg: K.TXT }]
      ],
      buttons: [
        { label: "\u7A0D\u540E", action: "later" },
        { label: "\u91CD\u8BD5\u6E05\u7406", action: "retry" },
        { label: "\u4FDD\u7559\u5BC6\u94A5", action: "keep" }
      ],
      onAction: async (button) => {
        if (button?.action === "retry") {
          this.app.closeOverlay();
          const result = await this.#retryPendingCredentialCleanups({ onlyRef: ref });
          await this.#refreshKeys();
          if (result.failed.length > 0) this.#showCredentialCleanupFailure(result.failed[0]);
        } else if (button?.action === "keep") {
          const saved = this.pendingCredentialCleanups.get(ref);
          this.pendingCredentialCleanups.delete(ref);
          if (!this.#persistCredentialCleanups()) {
            this.pendingCredentialCleanups.set(ref, saved);
            this.app.toast("\u65E0\u6CD5\u4FDD\u5B58\u4FDD\u7559\u51B3\u5B9A\uFF0C\u6E05\u7406\u4EFB\u52A1\u4ECD\u5F85\u5904\u7406");
          } else {
            this.app.closeOverlay();
            this.app.toast(`\u5DF2\u4FDD\u7559 ${ref}\uFF0C\u4E0D\u4F1A\u518D\u81EA\u52A8\u6E05\u7406`);
          }
        } else {
          this.app.closeOverlay();
          this.app.toast(`${ref} \u4ECD\u5F85\u6E05\u7406`);
        }
        this.#rebuild();
        this.app.redraw();
      }
    });
    this.app.redraw();
  }
  /** One batched credentials.describe over every referenced key, exactly like
   *  the web page's store join. Reads are structurally value-free: only the
   *  configured/source/writable view ever reaches this panel. */
  async #refreshKeys() {
    try {
      const refs = [...new Set([
        ...this.routes.map((r) => this.#keyRef(r)),
        ...this.directory.filter((entry) => this.configuredDirectory.has(entry.provider)).map((entry) => this.#keyRef(entry.provider))
      ].filter((ref) => KEY_REF_OK.test(ref)))];
      if (refs.length === 0) {
        this.keyStatus = {};
        return;
      }
      const res = await this.app.api.call("credentials.describe", { refs });
      this.keyStatus = res?.credentials ?? {};
    } catch (e) {
      this.keyStatus = {};
    }
  }
  #entry(route) {
    return this.directory.find((entry) => entry.provider === route);
  }
  #namespace(route) {
    return this.#entry(route)?.settingsNs ?? "llm-pi-ai";
  }
  #configuredEntry(entry) {
    if (this.configuredDirectory.has(entry.provider)) return true;
    const view = this.namespaceViews.get(entry.settingsNs);
    if (!view) return false;
    if (entry.settingsPath.length === 0) return entry.active === true || configAt(view.user, entry.settingsPath) !== void 0;
    return configAt(view.value, entry.settingsPath) !== void 0;
  }
  /** The credential reference a profile names, or the web's derived default. */
  #keyRef(route) {
    const p = this.#profile(route);
    return p.apiKeyEnv && p.apiKeyEnv.length > 0 ? p.apiKeyEnv : deriveKeyRef(route);
  }
  #syncRoutes() {
    const configuredDirectory = this.directory.filter((entry) => this.configuredDirectory.has(entry.provider)).map((entry) => entry.provider);
    this.routes = [.../* @__PURE__ */ new Set([...configuredDirectory, ...Object.keys(this.resolvedProviders), ...Object.keys(this.providers)])];
  }
  #route() {
    return this.routes[this.sel] ?? null;
  }
  #draftProfile(route) {
    if (route == null) return null;
    if (this.externalDrafts.has(route)) return this.externalDrafts.get(route);
    this.providers[route] ??= {};
    return this.providers[route];
  }
  #profile(route) {
    if (route == null) return null;
    if (this.externalDrafts.has(route)) return mergeConfig(this.externalInherited.get(route), this.externalDrafts.get(route));
    const effective = mergeConfig(this.inheritedProviders[route], this.providers[route]);
    const entry = this.#entry(route);
    if (!effective.displayName && entry?.declared !== true) effective.displayName = entry?.displayName;
    return effective;
  }
  #models(route, { mutable = false } = {}) {
    const draft = mutable ? this.#draftProfile(route) : this.externalDrafts.has(route) ? this.externalDrafts.get(route) : this.providers[route];
    if (mutable && !Array.isArray(draft.models)) draft.models = cloneConfig(this.#profile(route).models ?? []);
    return draft?.models ?? this.#profile(route).models ?? [];
  }
  #pruneEmptyDraft(route) {
    if (this.externalDrafts.has(route) || this.materializeRoutes.has(route)) return;
    if (!Object.hasOwn(JSON.parse(this.hostSnapshot), route) && Object.keys(this.providers[route] ?? {}).length === 0) {
      delete this.providers[route];
    }
  }
  #stripCompat(route) {
    const profile = this.#draftProfile(route);
    delete profile.compat;
    if (this.#models(route).some((model) => model.compat !== void 0)) {
      for (const model of this.#models(route, { mutable: true })) delete model.compat;
    }
  }
  #formRows() {
    const route = this.#route();
    if (route == null) return [];
    const p = this.#profile(route);
    const entry = this.#entry(route);
    const officialDeepSeek = entry?.settingsNs === "llm-deepseek";
    const catalogRoute = entry?.settingsNs === "llm-pi-ai" && entry.declared !== true;
    const ownsIdentity = !officialDeepSeek && !catalogRoute;
    const items = [];
    if (this.draftRoute === route) items.push({ kind: "field", key: "route", label: "\u8DEF\u7531\u540D", value: route });
    if (ownsIdentity) items.push({ kind: "field", key: "displayName", label: "\u663E\u793A\u540D", value: p.displayName ?? "" });
    const api = p.api ?? "";
    if (ownsIdentity) {
      items.push({
        kind: "field",
        key: "api",
        label: "\u534F\u8BAE api",
        value: api,
        cycle: API_PROTOCOLS.includes(api) ? API_PROTOCOLS : ["", ...api ? [api] : [], ...API_PROTOCOLS],
        completions: API_PROTOCOLS,
        note: "Tab \u5207\u6362"
      });
    }
    items.push({ kind: "field", key: "baseURL", label: "baseURL", value: p.baseURL ?? "", note: officialDeepSeek ? "\u7559\u7A7A=https://api.deepseek.com" : catalogRoute ? "\u7559\u7A7A=\u63D0\u4F9B\u65B9\u9ED8\u8BA4" : void 0 });
    if (ownsIdentity) {
      items.push({ kind: "field", key: "reasoning", label: "\u9ED8\u8BA4\u601D\u8003\u5F3A\u5EA6", value: p.reasoning ?? "", cycle: ["", ...THINKING_LEVELS], completions: THINKING_LEVELS, note: "\u7559\u7A7A=\u6A21\u578B\u9ED8\u8BA4 \xB7 Tab \u5207\u6362" });
      items.push({ kind: "field", key: "defaultContextWindow", label: "\u9ED8\u8BA4\u4E0A\u4E0B\u6587", value: p.defaultContextWindow ?? "", numeric: true });
      items.push({ kind: "field", key: "defaultMaxTokens", label: "\u9ED8\u8BA4\u6700\u5927\u8F93\u51FA", value: p.defaultMaxTokens ?? "", numeric: true });
      for (const modality of INPUT_MODALITIES) {
        items.push({ kind: "choice", key: `defaultInput.${modality}`, label: `\u9ED8\u8BA4\u8F93\u5165 ${modality}`, value: (p.defaultInput ?? DEFAULT_INPUT_MODALITIES).includes(modality) ? "\u2713" : "\xB7" });
      }
      if (api === "openai-completions") {
        items.push({ kind: "field", key: "compat.thinkingFormat", label: "compat.thinkingFormat", value: p.compat?.thinkingFormat ?? "", completions: THINKING_FORMATS, note: "\u53EF\u9009 \xB7 Tab \u8865\u5168" });
        items.push({ kind: "field", key: "compat.supportsReasoningEffort", label: "compat.supportsReasoningEffort", value: p.compat?.supportsReasoningEffort == null ? "" : String(p.compat.supportsReasoningEffort), completions: ["true", "false"], note: "\u53EF\u9009 \xB7 true/false" });
      }
    }
    const keyRef = this.#keyRef(route);
    items.push({ kind: "key", key: "apiKeyEnv", label: "API \u5BC6\u94A5", ref: keyRef, pending: this.pendingProbeKeys.has(route), action: () => this.#editKey(route, keyRef) });
    if (this.writable && this.keyStatus?.[keyRef]?.configured && this.keyStatus[keyRef].writable === true) items.push({ kind: "button", label: "\u6E05\u9664 API \u5BC6\u94A5\u2026", action: () => this.#clearKey(route, keyRef) });
    const models = p.models ?? [];
    const names = models.slice(0, 5).map((m) => inlineLabel(m.id || "\uFF08\u672A\u547D\u540D\uFF09")).join(" \xB7 ");
    const inheritedCatalog = models.length === 0 && (officialDeepSeek || catalogRoute);
    items.push({ kind: "button", label: "\u6A21\u578B\u7BA1\u7406", sub: inheritedCatalog ? "\u4F7F\u7528 Host \u5185\u7F6E\u6A21\u578B\u76EE\u5F55" : names + (models.length > 5 ? " \xB7 \u2026" : ""), action: () => this.#openModels() });
    items.push({ kind: "button", label: "\u{1F4BE} \u4FDD\u5B58\u914D\u7F6E", action: () => this.#save() });
    const externalUserConfig = !officialDeepSeek && this.externalUserConfigured.has(route);
    if (externalUserConfig) {
      items.push({ kind: "button", label: "\u{1F5D1} \u53D6\u6D88\u914D\u7F6E\u63D0\u4F9B\u65B9", action: () => this.#unconfigureExternalProvider() });
    } else if (!officialDeepSeek && Object.hasOwn(this.providers, route) && !Object.hasOwn(this.baseProviders, route)) {
      items.push({ kind: "button", label: catalogRoute ? "\u{1F5D1} \u53D6\u6D88\u914D\u7F6E\u63D0\u4F9B\u65B9" : "\u{1F5D1} \u5220\u9664\u4F9B\u5E94\u5546", action: () => this.#deleteProvider() });
    }
    return items;
  }
  /** The 模型管理 sub-buffer: scan first, then the model-info form rows. */
  #subItems() {
    const route = this.#route();
    if (route == null) return [];
    const p = this.#profile(route);
    const entry = this.#entry(route);
    const officialDeepSeek = entry?.settingsNs === "llm-deepseek";
    const catalogRoute = entry?.settingsNs === "llm-pi-ai" && entry.declared !== true;
    const items = [];
    if (!officialDeepSeek) items.push({ kind: "button", label: "\u{1F504} \u81EA\u52A8\u53D1\u73B0\u53EF\u7528\u6A21\u578B", action: () => this.#scan() });
    if ((officialDeepSeek || catalogRoute) && Object.hasOwn(this.#draftProfile(route), "models")) {
      items.push({ kind: "button", label: "\u21BA \u6062\u590D Host \u5185\u7F6E\u6A21\u578B\u76EE\u5F55", action: () => this.#resetModels() });
    }
    const models = p.models ?? [];
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi];
      items.push({ kind: "model", idx: mi, id: m.id ?? "", name: m.name ?? "", ctx: m.contextWindow ?? null, max: m.maxTokens ?? null });
      if (this.modelsSel === mi) {
        items.push({ kind: "field", key: `model.${mi}.id`, label: "  \u6A21\u578B id", value: m.id ?? "" });
        items.push({ kind: "field", key: `model.${mi}.name`, label: "  \u6A21\u578B\u540D", value: m.name ?? "" });
        items.push({ kind: "field", key: `model.${mi}.contextWindow`, label: "  \u4E0A\u4E0B\u6587\u7A97\u53E3", value: m.contextWindow ?? "", numeric: true });
        items.push({ kind: "field", key: `model.${mi}.maxTokens`, label: "  \u6700\u5927\u8F93\u51FA", value: m.maxTokens ?? "", numeric: true });
        if (!officialDeepSeek && !catalogRoute) {
          const reasoningState = m.reasoningEfforts === void 0 ? "\u7EE7\u627F" : m.reasoningEfforts === false ? "\u5173\u95ED" : "\u81EA\u5B9A\u4E49";
          items.push({ kind: "choice", key: `model.${mi}.reasoningMode`, label: "  \u601D\u8003\u80FD\u529B", value: reasoningState, cycle: ["\u7EE7\u627F", "\u5173\u95ED", "\u81EA\u5B9A\u4E49"] });
          if (reasoningState === "\u81EA\u5B9A\u4E49") {
            for (const level of THINKING_LEVELS) {
              const declared = Object.hasOwn(m.reasoningEfforts, level);
              const value = declared && m.reasoningEfforts[level] === null ? "null" : declared ? m.reasoningEfforts[level] : "";
              items.push({ kind: "field", key: `model.${mi}.reasoning.${level}`, label: `    ${level}`, value, note: level === "off" ? "null \u8868\u793A\u5173\u95ED" : "\u81F3\u5C11\u586B\u5199\u4E00\u79CD\u975E off \u5F3A\u5EA6" });
            }
          }
          const inputState = m.input === void 0 || m.input.length === 0 ? "\u7EE7\u627F" : "\u81EA\u5B9A\u4E49";
          items.push({ kind: "choice", key: `model.${mi}.inputMode`, label: "  \u8F93\u5165\u80FD\u529B", value: inputState, cycle: ["\u7EE7\u627F", "\u81EA\u5B9A\u4E49"] });
          if (inputState === "\u81EA\u5B9A\u4E49") {
            for (const modality of INPUT_MODALITIES) items.push({ kind: "choice", key: `model.${mi}.input.${modality}`, label: `    ${modality}`, value: m.input.includes(modality) ? "\u2713" : "\xB7", cycle: ["\u2713", "\xB7"] });
          }
          if (p.api === "openai-completions") {
            items.push({ kind: "field", key: `model.${mi}.compat.thinkingFormat`, label: "  compat.thinkingFormat", value: m.compat?.thinkingFormat ?? "", completions: THINKING_FORMATS, note: "\u53EF\u9009 \xB7 Tab \u8865\u5168" });
            items.push({ kind: "field", key: `model.${mi}.compat.supportsReasoningEffort`, label: "  compat.supportsReasoningEffort", value: m.compat?.supportsReasoningEffort == null ? "" : String(m.compat.supportsReasoningEffort), completions: ["true", "false"], note: "\u53EF\u9009 \xB7 true/false" });
          }
        }
      }
    }
    items.push({ kind: "button", label: "\uFF0B \u6DFB\u52A0\u6A21\u578B", action: () => this.#addModel() });
    items.push({ kind: "button", label: "\u{1F5D1} \u5220\u9664\u9009\u4E2D\u6A21\u578B", action: () => this.#deleteModel() });
    items.push({ kind: "button", label: "\u25C9 \u8BBE\u4E3A\u5F53\u524D\u4F1A\u8BDD\u53CA\u540E\u7EED Agent \u9ED8\u8BA4\u6A21\u578B", action: () => this.#setDefaultModel() });
    return items;
  }
  #openModels() {
    this.sub = { cursor: 0 };
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  #rebuild() {
    const listLines = [];
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      const p = this.#profile(r);
      const entry = this.#entry(r);
      const cur = i === this.sel;
      const editing = cur && this.mode === "form";
      listLines.push([{
        t: ` ${cur ? "\u25CF" : " "} ${truncate(inlineLabel(p.displayName || entry?.displayName || r), 18)}${editing ? " \u270E" : ""}`,
        fg: cur ? T.SELFG : T.TXT,
        bg: cur ? editing ? T.MENUSEL : T.SELBG : T.BG2,
        bold: cur
      }]);
    }
    const addCur = this.sel === this.routes.length;
    listLines.push([{ t: ` ${addCur ? "\u25CF" : " "} \uFF0B \u6DFB\u52A0\u4F9B\u5E94\u5546`, fg: addCur ? T.SELFG : T.ACCENT, bg: addCur ? T.MENUSEL : T.BG2, bold: true }]);
    this.listView.setLines(listLines);
    this.listView.scrollY = Math.max(0, Math.min(this.listView.maxScroll(), this.sel < this.listView.scrollY ? this.sel : this.sel >= this.listView.scrollY + this.listView.h ? this.sel - this.listView.h + 1 : this.listView.scrollY));
    const route = this.#route();
    const formLines = [];
    this.formClickMap = [];
    const pushForm = (line, target = null) => {
      formLines.push(line);
      this.formClickMap.push(target);
    };
    for (const [ref, task] of this.pendingCredentialCleanups) {
      pushForm([{
        t: truncate(`  \u26A0 ${ref} \u5F85\u6E05\u7406 (${inlineLabel(task.error)}) \xB7 [c \u5904\u7406]`, Math.max(20, this.formView.w - 4)),
        fg: K.WARN,
        bold: true
      }], { type: "cleanup", ref });
    }
    if (this.addMode) {
      const selectedAdd = this.addItems[this.addCursor];
      pushForm([{ t: "  \u6DFB\u52A0\u63D0\u4F9B\u65B9 \u2014 Host \u53EF\u7528\u76EE\u5F55", fg: K.ACCENT, bold: true }]);
      pushForm([{ t: "  \u2191/\u2193 \u6216 j/k \u5FAA\u73AF\u9009\u62E9 \xB7 Enter \u6DFB\u52A0 \xB7 Esc \u8FD4\u56DE", fg: K.FAINT }]);
      if (selectedAdd?.custom) {
        pushForm([{ t: "  \u9884\u89C8  \u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9", fg: K.ACCENT, bold: true }]);
        pushForm([{ t: "        \u624B\u52A8\u586B\u5199\u8DEF\u7531\u3001\u534F\u8BAE\u3001baseURL \u4E0E\u81F3\u5C11\u4E00\u4E2A\u6A21\u578B", fg: K.TXT }]);
        pushForm([{ t: "        API \u5BC6\u94A5\u5199\u5165 <ROUTE>_API_KEY\uFF1B\u652F\u6301\u6A21\u578B\u53D1\u73B0\uFF08\u534F\u8BAE\u5141\u8BB8\u65F6\uFF09", fg: K.DIM }]);
      } else if (selectedAdd?.entry) {
        const entry = selectedAdd.entry;
        const kind = entry.settingsNs === "llm-deepseek" ? "\u5B98\u65B9\u9002\u914D\u5668" : entry.declared === true ? "\u5DF2\u58F0\u660E\u63D0\u4F9B\u65B9" : "Host \u5185\u7F6E\u76EE\u5F55";
        const address = `${entry.settingsNs}${entry.settingsPath.length ? ` \xB7 ${entry.settingsPath.join(".")}` : " \xB7 \u6839\u914D\u7F6E"}`;
        pushForm([{ t: `  \u9884\u89C8  ${truncate(inlineLabel(entry.displayName || entry.provider), 32)}  [${kind}]`, fg: entry.settingsNs === "llm-deepseek" ? K.OK : K.ACCENT, bold: true }]);
        pushForm([{ t: `        \u8DEF\u7531 ${truncate(inlineLabel(entry.provider), 30)} \xB7 ${entry.active ? "\u5F53\u524D\u5DF2\u6FC0\u6D3B" : "\u6DFB\u52A0\u540E\u6FC0\u6D3B"}`, fg: K.TXT }]);
        pushForm([{ t: `        ${truncate(address, Math.max(20, this.formView.w - 10))}`, fg: K.DIM }]);
        const resolvedProfile = isRecord(configAt(this.namespaceViews.get(entry.settingsNs)?.value, entry.settingsPath)) ? configAt(this.namespaceViews.get(entry.settingsNs)?.value, entry.settingsPath) : {};
        const credentialRef = typeof resolvedProfile.apiKeyEnv === "string" && resolvedProfile.apiKeyEnv ? resolvedProfile.apiKeyEnv : deriveKeyRef(entry.provider);
        pushForm([{ t: `        \u6A21\u578B/\u534F\u8BAE/\u9ED8\u8BA4\u7AEF\u70B9\u7531 Host \u63D0\u4F9B \xB7 \u5BC6\u94A5 ${credentialRef}`, fg: K.FAINT }]);
      }
      pushForm([{ t: "" }]);
      const addStartLine = formLines.length;
      for (let i = 0; i < this.addItems.length; i++) {
        const item = this.addItems[i], cur = i === this.addCursor;
        const meta = item.custom ? "\u624B\u52A8\u586B\u5199\u7AEF\u70B9/\u534F\u8BAE/\u6A21\u578B" : item.entry.settingsNs === "llm-deepseek" ? "\u5B98\u65B9" : "\u5185\u7F6E\u76EE\u5F55";
        pushForm([{ t: `  ${cur ? "\u25B8" : " "} ${truncate(inlineLabel(item.label), 30)}  [${meta}]`, fg: cur ? T.SELFG : item.custom ? K.ACCENT : T.TXT, bg: cur ? T.MENUSEL : T.BG2, bold: cur }], { type: "add", index: i });
      }
      this.formItems = [];
      const cursorLine = addStartLine + this.addCursor;
      if (cursorLine < this.formView.scrollY) this.formView.scrollY = cursorLine;
      else if (cursorLine >= this.formView.scrollY + this.formView.h) this.formView.scrollY = Math.max(0, cursorLine - this.formView.h + 1);
    } else if (route == null) {
      pushForm([{ t: "  \u5DE6\u4FA7 \u2191/\u2193 \u9009\u62E9\u4F9B\u5E94\u5546,Enter \u6253\u5F00\u7F16\u8F91", fg: K.FAINT }]);
      pushForm([{ t: "  \u201C\uFF0B \u6DFB\u52A0\u4F9B\u5E94\u5546\u201D\u5148\u663E\u793A Host \u5B98\u65B9/\u5185\u7F6E\u76EE\u5F55\uFF0C\u672B\u9879\u4E3A\u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9", fg: K.FAINT }]);
      pushForm([{ t: "  \u9AD8\u7EA7\u5B57\u6BB5(modelOverrides/headers/\u91CD\u8BD5/\u8D85\u65F6/transport)\u5728 \u8BBE\u7F6E \u4E2D\u7F16\u8F91", fg: K.FAINT }]);
      pushForm([{ t: "  Esc \u9000\u51FA\u4F9B\u5E94\u5546\u914D\u7F6E", fg: K.FAINT }]);
      this.formItems = [];
    } else if (this.scanMode) {
      pushForm([{ t: `  \u626B\u63CF ${truncate(inlineLabel(this.#profile(route).baseURL), 44)} \u2014 \u7A7A\u683C\u52FE\u9009,Enter \u6DFB\u52A0,\u2191/\u2193 \u79FB\u52A8`, fg: K.ACCENT, bold: true }]);
      if (this.scanning) pushForm([{ t: "  \u626B\u63CF\u4E2D\u2026", fg: K.WARN }]);
      let cursorLine = null;
      for (let i = 0; i < this.scanItems.length; i++) {
        const m = this.scanItems[i];
        const on = this.scanSel.has(m.id);
        const cur = i === this.scanCursor;
        if (cur) cursorLine = formLines.length;
        pushForm([{ t: `  ${cur ? "\u25B8" : " "} [${on ? "x" : " "}] ${truncate(inlineLabel(m.id), this.formView.w - 10)}`, fg: on ? K.OK : cur ? T.TXT : K.DIM, bg: cur ? T.MENUSEL : T.BG2 }], { type: "scan", index: i });
      }
      pushForm([{ t: "  Enter \u6DFB\u52A0\u9009\u4E2D \xB7 Esc \u53D6\u6D88\u626B\u63CF", fg: K.FAINT }]);
      this.formItems = [];
      if (cursorLine != null && cursorLine < this.formView.scrollY) this.formView.scrollY = cursorLine;
      else if (cursorLine != null && cursorLine >= this.formView.scrollY + this.formView.h) this.formView.scrollY = Math.max(0, cursorLine - this.formView.h + 1);
    } else {
      const isSub = this.sub != null;
      const items = isSub ? this.#subItems() : this.#formRows();
      if (isSub) this.subItems = items;
      else this.formItems = items;
      const w = Math.max(30, this.formView.w - 4);
      const cursor = isSub ? this.sub.cursor : this.formIdx;
      let cursorLine = null;
      if (isSub) pushForm([{ t: `  \u6A21\u578B\u7BA1\u7406 \u2014 ${truncate(inlineLabel(this.#profile(route).displayName || route), 30)}  (Esc \u8FD4\u56DE)`, fg: K.ACCENT, bold: true }]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const cur = i === cursor;
        let t;
        if (it.kind === "field" || it.kind === "choice") {
          const v = it.value === "" || it.value == null ? "\uFF08\u7A7A\uFF09" : inlineLabel(it.value);
          t = ` ${cur ? "\u25B8" : " "} ${it.label}: ${truncate(v, w - strWidth(it.label) - 6)}${it.note ? `  [${it.note}]` : ""}`;
        } else if (it.kind === "notice") {
          t = `   ${it.label}: ${truncate(inlineLabel(it.value), w - strWidth(it.label) - 6)}`;
        } else if (it.kind === "key") {
          const st = this.keyStatus?.[it.ref];
          const status = it.pending ? "\u25D0 \u5F85\u4FDD\u5B58" : st?.configured ? "\u25CF \u5DF2\u914D\u7F6E" : "\u25CB \u672A\u914D\u7F6E";
          const ro = st && st.writable === false ? " [\u53EA\u8BFB]" : "";
          t = ` ${cur ? "\u25B8" : " "} ${it.label}: ${status}${ro} (${it.ref})`;
        } else if (it.kind === "model") {
          const extras = [it.ctx != null ? `ctx ${it.ctx}` : "", it.max != null ? `max ${it.max}` : ""].filter(Boolean).join(" ");
          t = ` ${cur ? "\u25B8" : " "} \u6A21\u578B ${truncate(inlineLabel(it.id || "\uFF08\u672A\u547D\u540D\uFF09"), 24)}  ${truncate(inlineLabel(it.name || ""), 20)}  ${truncate(extras, 24)}`;
        } else {
          t = ` ${cur ? "\u25B8" : " "} ${it.label}`;
        }
        if (cur) cursorLine = formLines.length;
        pushForm([{ t: truncate(t, w), fg: cur ? T.SELFG : T.TXT, bg: cur ? T.MENUSEL : T.BG2 }], { type: "item", index: i, sub: isSub });
        if (!isSub && it.kind === "button" && it.sub) {
          pushForm([{ t: `       ${truncate(it.sub, w - 8)}`, fg: K.FAINT, bg: T.BG2 }]);
        }
      }
      pushForm([{ t: isSub ? "  \u2191/\u2193 \u79FB\u52A8 \xB7 Enter \u7F16\u8F91\u6216\u6267\u884C \xB7 Esc \u8FD4\u56DE\u4F9B\u5E94\u5546" : "  \u2191/\u2193 \u79FB\u52A8 \xB7 \u2192 \u8FDB\u5165\u9009\u9879 \xB7 \u2190 \u8FD4\u56DE\u5217\u8868 \xB7 Enter \u7F16\u8F91\u6216\u6267\u884C \xB7 Tab \u5207\u6362\u9009\u9879 \xB7 Esc \u8FD4\u56DE\u5217\u8868", fg: K.FAINT }]);
      if (cursorLine != null && cursorLine < this.formView.scrollY) this.formView.scrollY = cursorLine;
      else if (cursorLine != null && cursorLine >= this.formView.scrollY + this.formView.h) this.formView.scrollY = Math.max(0, cursorLine - this.formView.h + 1);
    }
    if (!this.writable) pushForm([{ t: "  \u6A21\u578B\u914D\u7F6E\u53EA\u8BFB \xB7 \u53EF\u6D4F\u89C8\u3001\u53D1\u73B0\u6A21\u578B\u548C\u5207\u6362\u5F53\u524D\u4F1A\u8BDD\u6A21\u578B", fg: K.WARN }]);
    this.formView.setLines(formLines);
    this.formView.scrollY = Math.max(0, Math.min(this.formView.scrollY, this.formView.maxScroll()));
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.formView.x - 1;
    screen.vline(mid, this.y, this.y + this.h - 1, "\u2502", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " \u6A21\u578B\u4F9B\u5E94\u5546", { fg: K.DIM });
    this.listView.render(screen);
    this.formView.render(screen);
  }
  #startEdit(label, value, commit, completions) {
    const popup = new EditPopup(this.app, {
      title: `\u7F16\u8F91 ${label}`,
      value,
      completions,
      onCommit: (text) => {
        commit(text);
        this.#rebuild();
        this.app.redraw();
      }
    });
    this.app.overlay = popup;
    this.app.focus(popup.input);
    this.app.redraw();
  }
  /** The web's apiKey judgement, mirrored: empty is fine (keep), whitespace-only
   *  and `NAME=value` / quoted forms fail, and the charset is printable ASCII. */
  #keyFailure(draft) {
    if (draft.length === 0) return null;
    const value = draft.trim();
    if (value.length === 0) return "\u5BC6\u94A5\u4E0D\u80FD\u53EA\u662F\u7A7A\u767D";
    if (/^[A-Z][A-Z0-9_]*=[^=]/.test(value)) return "\u5BC6\u94A5\u4E0D\u80FD\u662F NAME=value \u5F62\u5F0F\u7684\u73AF\u5883\u53D8\u91CF\u884C";
    if ((value[0] === '"' || value[0] === "'" || value[0] === "`") && value.length > 1 && value.endsWith(value[0])) return "\u5BC6\u94A5\u4E0D\u8981\u5E26\u5F15\u53F7";
    if (!/^[\x21-\x7E]+$/.test(value)) return "\u5BC6\u94A5\u53EA\u80FD\u5305\u542B\u53EF\u6253\u5370 ASCII \u5B57\u7B26";
    return null;
  }
  /** Edit the API key value the web-synced way: a masked, always-empty editor.
   *  The stored value is never read back; a non-empty commit stays write-only
   *  until #save persists it, while an empty commit keeps the existing key. */
  #clearKey(route, ref) {
    const users = this.routes.filter((candidate) => this.#keyRef(candidate) === ref);
    const others = users.filter((candidate) => candidate !== route);
    const pending = users.filter((candidate) => this.pendingProbeKeys.has(candidate));
    const lines = [
      [{ t: ` ${inlineLabel(ref)} \u662F\u51ED\u636E\u5B58\u50A8\u4E2D\u7684\u5168\u5C40\u5F15\u7528\u3002`, fg: K.WARN }],
      ...others.length > 0 ? [[{ t: ` \u5176\u4ED6\u5F15\u7528\u8005: ${truncate(others.map(inlineLabel).join("\u3001"), 52)}`, fg: K.WARN }]] : [],
      ...ref !== deriveKeyRef(route) ? [[{ t: " \u8FD9\u662F\u81EA\u5B9A\u4E49\u5F15\u7528\uFF0C\u53EF\u80FD\u8FD8\u88AB\u9762\u677F\u5916\u914D\u7F6E\u4F7F\u7528\u3002", fg: K.WARN }]] : [],
      ...pending.length > 0 ? [[{ t: ` ${pending.length} \u4E2A\u5F85\u4FDD\u5B58\u5BC6\u94A5\u8349\u7A3F\u4E5F\u4F1A\u53D6\u6D88\u3002`, fg: K.TXT }]] : [],
      [{ t: " \u6E05\u9664\u540E\uFF0C\u6240\u6709\u5F15\u7528\u8005\u5C06\u7ACB\u5373\u5931\u53BB\u6B64\u5BC6\u94A5\u3002", fg: K.TXT }]
    ];
    const w = Math.max(32, Math.min(64, this.app.screen.w - 4));
    const h = Math.min(lines.length + 4, this.app.screen.h);
    const confirm = new Popup({
      x: Math.max(0, Math.floor((this.app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor((this.app.screen.h - h) / 2)),
      w,
      h,
      title: "\u5168\u5C40\u6E05\u9664 API \u5BC6\u94A5",
      lines,
      buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u5168\u5C40\u6E05\u9664", action: "clear" }],
      onAction: async (btn) => {
        this.app.closeOverlay();
        if (btn.action !== "clear") {
          this.app.redraw();
          return;
        }
        try {
          await this.app.api.call("credentials.unset", { ref });
          for (const candidate of users) this.pendingProbeKeys.delete(candidate);
          this.app.toast(`\u5DF2\u5168\u5C40\u6E05\u9664 ${ref}`);
          await this.#refreshKeys();
          this.#rebuild();
        } catch (e) {
          this.app.toast(`\u6E05\u9664\u5BC6\u94A5\u5931\u8D25: ${e.message}`);
        }
        this.app.redraw();
      }
    });
    this.app.overlay = confirm;
    this.app.redraw();
  }
  #editKey(route, ref) {
    if (!KEY_REF_OK.test(ref)) {
      this.app.toast(`\u8DEF\u7531\u540D "${route}" \u65E0\u6CD5\u6D3E\u751F\u5408\u6CD5\u7684\u5BC6\u94A5\u5F15\u7528\u540D,\u8BF7\u5148\u628A\u8DEF\u7531\u540D\u6539\u6210\u5B57\u6BCD\u6570\u5B57(\u5982 my-gateway)`);
      return;
    }
    const st = this.keyStatus?.[ref];
    if (st?.writable === false) {
      this.app.toast(`${ref} \u4E3A\u53EA\u8BFB\u51ED\u636E`);
      return;
    }
    const popup = new EditPopup(this.app, {
      title: `\u8BBE\u7F6E API \u5BC6\u94A5 \u2014 ${ref}`,
      value: "",
      masked: true,
      statusHint: st?.configured ? "\u5DF2\u6709\u5BC6\u94A5 \xB7 \u7559\u7A7A\u4FDD\u6301\u539F\u503C\u4E0D\u53D8,\u8F93\u5165\u65B0\u503C\u5219\u8986\u76D6" : "\u5C1A\u672A\u914D\u7F6E\u5BC6\u94A5 \xB7 \u8F93\u5165\u65B0\u503C\u4FDD\u5B58",
      placeholder: "\u8F93\u5165\u65B0\u5BC6\u94A5\u2026\uFF08\u7559\u7A7A=\u4FDD\u6301\u539F\u503C,Enter \u786E\u5B9A,Esc \u53D6\u6D88\uFF09",
      onCommit: async (text) => {
        const failure = this.#keyFailure(text);
        if (failure) {
          this.app.toast(failure);
          this.#rebuild();
          this.app.redraw();
          return;
        }
        const v = text.trim();
        if (v === "") {
          this.app.toast("\u672A\u8F93\u5165\u65B0\u5BC6\u94A5,\u4FDD\u6301\u539F\u503C\u4E0D\u53D8");
          this.#rebuild();
          this.app.redraw();
          return;
        }
        this.pendingProbeKeys.set(route, v);
        if (!this.#profile(route)?.apiKeyEnv) this.#draftProfile(route).apiKeyEnv = ref;
        this.app.toast(`\u5BC6\u94A5\u5F85\u4FDD\u5B58\u5230 ${ref} \xB7 \u53EF\u5148\u7528\u4E8E\u81EA\u52A8\u53D1\u73B0`);
        this.#rebuild();
        this.app.redraw();
      }
    });
    this.app.overlay = popup;
    this.app.focus(popup.input);
    this.app.redraw();
  }
  #openAddProvider() {
    if (!this.writable) {
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB");
      return;
    }
    const configured = new Set(this.routes);
    const entries = this.directory.filter((entry) => entry.settingsNs && !configured.has(entry.provider));
    this.addItems = [
      ...entries.map((entry) => ({ entry, label: entry.displayName || entry.provider })),
      { custom: true, label: "\u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9" }
    ];
    this.addCursor = 0;
    this.addMode = true;
    this.mode = "list";
    this.#rebuild();
    this.app.redraw();
  }
  #addCustomProvider() {
    let name = "new-provider", i = 2;
    while (this.routes.includes(name) || this.#cleanupRouteReserved(name) || this.pendingCredentialCleanups.has(deriveKeyRef(name))) name = `new-provider-${i++}`;
    this.providers[name] = { api: "openai-completions", defaultInput: [...DEFAULT_INPUT_MODALITIES], models: [] };
    this.configuredDirectory.add(name);
    this.draftRoute = name;
    this.addMode = false;
    this.#syncRoutes();
    this.sel = this.routes.indexOf(name);
    this.mode = "form";
    this.formIdx = 0;
    this.sub = null;
    this.modelsSel = -1;
    this.#rebuild();
    this.app.redraw();
  }
  #addDirectoryProvider(entry) {
    if (!entry || !this.namespaceViews.has(entry.settingsNs)) {
      this.app.toast("\u8BE5\u63D0\u4F9B\u65B9\u7684\u8BBE\u7F6E namespace \u5F53\u524D\u4E0D\u53EF\u7528");
      return;
    }
    this.configuredDirectory.add(entry.provider);
    if (entry.settingsNs === "llm-pi-ai") {
      this.providers[entry.provider] ??= {};
      this.inheritedProviders[entry.provider] = {};
      this.materializeRoutes.add(entry.provider);
    } else {
      const view = this.namespaceViews.get(entry.settingsNs);
      const stored = configAt(view?.user, entry.settingsPath);
      this.externalDrafts.set(entry.provider, cloneConfig(stored ?? {}));
      if (stored !== void 0 && entry.settingsPath.length > 0) this.externalUserConfigured.add(entry.provider);
      this.externalInherited.set(entry.provider, mergeConfig(withoutOwned(configAt(view?.value, entry.settingsPath), stored), configAt(view?.base, entry.settingsPath)));
      this.externalSnapshots.set(entry.provider, JSON.stringify(this.externalDrafts.get(entry.provider)));
      this.externalHostSnapshots.set(entry.provider, JSON.stringify(this.externalDrafts.get(entry.provider)));
    }
    this.addMode = false;
    this.#syncRoutes();
    this.sel = this.routes.indexOf(entry.provider);
    this.mode = "form";
    this.formIdx = 0;
    this.modelsSel = -1;
    this.sub = null;
    this.#rebuild();
    this.app.redraw();
  }
  #activateAddItem() {
    const item = this.addItems[this.addCursor];
    if (!item) return;
    if (item.custom) this.#addCustomProvider();
    else this.#addDirectoryProvider(item.entry);
  }
  #activateItem() {
    if (this.mode === "list") {
      if (this.sel === this.routes.length) {
        this.#openAddProvider();
        return;
      }
      this.addMode = false;
      this.mode = "form";
      this.formIdx = 0;
      this.modelsSel = -1;
      this.#rebuild();
      this.app.redraw();
      return;
    }
    const items = this.sub != null ? this.subItems : this.formItems;
    const idx = this.sub != null ? this.sub.cursor : this.formIdx;
    const it = items[idx];
    if (!it) return;
    const route = this.#route();
    const effective = this.#profile(route);
    const settingsMutation = it.kind === "field" || it.kind === "choice" || it.kind === "key" || it.kind === "button" && /保存配置|删除供应商|取消配置提供方|添加模型|删除选中模型|恢复 Host 内置模型目录|清除 API 密钥/.test(it.label);
    if (!this.writable && settingsMutation) {
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB");
      return;
    }
    if (it.kind === "field") {
      this.#startEdit(it.label, it.value, (text) => {
        if (it.key === "api" && text.trim() && !API_PROTOCOLS.includes(text.trim())) {
          this.app.toast(`\u534F\u8BAE ${text.trim()} \u4E0D\u53D7\u652F\u6301`);
          return;
        }
        if (it.key === "reasoning" && text.trim() && !THINKING_LEVELS.includes(text.trim())) {
          this.app.toast(`\u601D\u8003\u5F3A\u5EA6 ${text.trim()} \u4E0D\u53D7\u652F\u6301`);
          return;
        }
        if (it.numeric) {
          const candidate = text.trim() === "" ? void 0 : Number(text);
          if (candidate !== void 0 && (!Number.isInteger(candidate) || candidate <= 0)) {
            this.app.toast("\u8BF7\u8F93\u5165\u6B63\u6574\u6570");
            return;
          }
        }
        if (it.key !== "route" && text.trim() === String(it.value ?? "").trim()) return;
        const p = this.#draftProfile(route);
        if (it.key === "route") {
          const t = text.trim();
          if (!ROUTE_PATTERN.test(t)) {
            this.app.toast("\u8DEF\u7531\u540D\u987B\u4EE5\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u53EA\u80FD\u5305\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u5355\u8FDE\u5B57\u7B26");
            return;
          }
          if (t !== route && this.routes.includes(t)) {
            this.app.toast(`\u8DEF\u7531 ${t} \u5DF2\u5B58\u5728`);
            return;
          }
          if (t !== route && (this.#cleanupRouteReserved(t) || this.pendingCredentialCleanups.has(deriveKeyRef(t)))) {
            this.app.toast(`\u8DEF\u7531 ${t} \u7684\u6258\u7BA1\u5BC6\u94A5\u4ECD\u5F85\u5904\u7406\uFF0C\u8BF7\u5148\u5B8C\u6210\u6E05\u7406`);
            return;
          }
          if (t !== route) {
            const profile = this.providers[route];
            const oldDerivedRef = deriveKeyRef(route);
            this.providers[t] = profile;
            delete this.providers[route];
            if (profile.apiKeyEnv === oldDerivedRef) profile.apiKeyEnv = deriveKeyRef(t);
            if (this.pendingProbeKeys.has(route)) {
              this.pendingProbeKeys.set(t, this.pendingProbeKeys.get(route));
              this.pendingProbeKeys.delete(route);
            }
            this.draftRoute = t;
            this.#syncRoutes();
            this.sel = this.routes.indexOf(t);
          }
        } else if (it.numeric) {
          const n = text.trim() === "" ? void 0 : Number(text);
          if (it.key.startsWith("model.")) {
            const [, mi, field] = it.key.split(".");
            const model = this.#models(route, { mutable: true })[Number(mi)];
            if (n === void 0) delete model[field];
            else model[field] = n;
          } else if (n === void 0) delete p[it.key];
          else p[it.key] = n;
        } else if (it.key.startsWith("model.")) {
          const [, mi, field, detail] = it.key.split(".");
          const model = this.#models(route, { mutable: true })[Number(mi)];
          if (field === "reasoning") {
            if (!model.reasoningEfforts || model.reasoningEfforts === false) model.reasoningEfforts = {};
            const value = text.trim();
            if (!value) delete model.reasoningEfforts[detail];
            else if (value === "null") {
              if (detail !== "off") {
                this.app.toast("\u53EA\u6709 off \u5F3A\u5EA6\u53EF\u4EE5\u4F7F\u7528 null");
                return;
              }
              model.reasoningEfforts[detail] = null;
            } else model.reasoningEfforts[detail] = value;
          } else if (field === "compat") {
            model.compat ??= {};
            const value = text.trim();
            if (!value) delete model.compat[detail];
            else if (detail === "supportsReasoningEffort") {
              if (value !== "true" && value !== "false") {
                this.app.toast("\u8BF7\u8F93\u5165 true \u6216 false,\u6216\u7559\u7A7A\u5220\u9664");
                return;
              }
              model.compat[detail] = value === "true";
            } else {
              if (!THINKING_FORMATS.includes(value)) {
                this.app.toast("\u8BF7\u9009\u62E9\u6709\u6548\u7684 thinkingFormat");
                return;
              }
              model.compat[detail] = value;
            }
            if (Object.keys(model.compat).length === 0) delete model.compat;
          } else {
            const value = text.trim();
            if (!value && field !== "id") delete model[field];
            else model[field] = value;
          }
        } else if (it.key.startsWith("compat.")) {
          const field = it.key.slice("compat.".length);
          p.compat ??= {};
          const value = text.trim();
          if (!value) delete p.compat[field];
          else if (field === "supportsReasoningEffort") {
            if (value !== "true" && value !== "false") {
              this.app.toast("\u8BF7\u8F93\u5165 true \u6216 false,\u6216\u7559\u7A7A\u5220\u9664");
              return;
            }
            p.compat[field] = value === "true";
          } else {
            if (!THINKING_FORMATS.includes(value)) {
              this.app.toast("\u8BF7\u9009\u62E9\u6709\u6548\u7684 thinkingFormat");
              return;
            }
            p.compat[field] = value;
          }
          if (Object.keys(p.compat).length === 0) delete p.compat;
        } else {
          const value = text.trim();
          if (!value) delete p[it.key];
          else p[it.key] = value;
          if (it.key === "api" && this.#profile(route).api !== "openai-completions") this.#stripCompat(route);
        }
        this.#pruneEmptyDraft(route);
      }, it.completions);
      return;
    }
    if (it.kind === "choice") {
      if (it.key.startsWith("defaultInput.")) {
        const modality = it.key.slice("defaultInput.".length);
        const set = new Set(effective.defaultInput ?? DEFAULT_INPUT_MODALITIES);
        if (set.has(modality)) {
          if (set.size === 1) {
            this.app.toast("defaultInput \u81F3\u5C11\u9700\u8981\u4E00\u79CD\u6A21\u6001");
            return;
          }
          set.delete(modality);
        } else set.add(modality);
        this.#draftProfile(route).defaultInput = INPUT_MODALITIES.filter((item) => set.has(item));
      } else if (it.key.startsWith("model.")) {
        const [, mi, field, detail] = it.key.split(".");
        if (field === "input") {
          const current2 = this.#models(route)[Number(mi)];
          if (current2.input?.includes(detail) && current2.input.length === 1) {
            this.app.toast("\u6A21\u578B\u8F93\u5165\u80FD\u529B\u81F3\u5C11\u9700\u8981\u4E00\u79CD\u6A21\u6001");
            return;
          }
        }
        const model = this.#models(route, { mutable: true })[Number(mi)];
        if (field === "reasoningMode") {
          const next = it.value === "\u7EE7\u627F" ? "\u5173\u95ED" : it.value === "\u5173\u95ED" ? "\u81EA\u5B9A\u4E49" : "\u7EE7\u627F";
          if (next === "\u7EE7\u627F") delete model.reasoningEfforts;
          else if (next === "\u5173\u95ED") model.reasoningEfforts = false;
          else model.reasoningEfforts = { medium: "medium" };
        } else if (field === "inputMode") {
          if (it.value === "\u7EE7\u627F") model.input = [...DEFAULT_INPUT_MODALITIES];
          else delete model.input;
        } else if (field === "input") {
          const set = new Set(model.input);
          if (set.has(detail)) set.delete(detail);
          else set.add(detail);
          model.input = INPUT_MODALITIES.filter((item) => set.has(item));
        }
      }
      this.#rebuild();
      this.app.redraw();
      return;
    }
    if (it.kind === "model") {
      this.modelsSel = this.modelsSel === it.idx ? -1 : it.idx;
      this.#rebuild();
      this.app.redraw();
      return;
    }
    if (it.kind === "button" || it.kind === "key") {
      it.action();
      this.app.redraw();
      return;
    }
  }
  #resetModels() {
    const route = this.#route();
    if (!route) return;
    if (!this.writable) {
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB");
      return;
    }
    const profile = this.#draftProfile(route);
    delete profile.models;
    this.modelsSel = -1;
    this.app.toast("\u5DF2\u6062\u590D Host \u5185\u7F6E\u6A21\u578B\u76EE\u5F55\uFF08\u4FDD\u5B58\u540E\u751F\u6548\uFF09");
    this.#rebuild();
    this.app.redraw();
  }
  #addModel() {
    const route = this.#route();
    if (!route) return;
    const models = this.#models(route, { mutable: true });
    models.push({ id: "" });
    this.modelsSel = models.length - 1;
    this.#rebuild();
    this.app.redraw();
  }
  #deleteModel() {
    const route = this.#route();
    if (!route || this.modelsSel < 0) {
      this.app.toast("\u5148\u9009\u4E2D\u4E00\u4E2A\u6A21\u578B");
      return;
    }
    const model = this.#models(route)[this.modelsSel];
    this.#confirmDelete(`\u5220\u9664\u6A21\u578B ${model?.name || model?.id || "\uFF08\u672A\u547D\u540D\uFF09"}\uFF1F`, () => {
      this.#models(route, { mutable: true }).splice(this.modelsSel, 1);
      this.modelsSel = -1;
      this.#rebuild();
      this.app.redraw();
    });
  }
  async #setDefaultModel() {
    const route = this.#route();
    if (!route) return;
    const m = this.#models(route)[this.modelsSel];
    if (!m?.id) {
      this.app.toast("\u5148\u9009\u4E2D\u4E00\u4E2A\u6A21\u578B");
      return;
    }
    if (!this.app.currentSession) {
      this.app.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    try {
      await this.app.api.call("session.selectModel", { sessionId: this.app.currentSession, provider: route, model: m.id });
      if (typeof this.app.updateModel === "function") await this.app.updateModel();
      this.app.toast(`\u5DF2\u5207\u6362 ${route}/${m.id}\uFF0C\u540E\u7EED Agent/Subagent \u9ED8\u8BA4\u4F7F\u7528\u6B64\u6A21\u578B`);
    } catch (e) {
      this.app.toast(`\u5207\u6362\u5931\u8D25: ${e.message}`);
    }
  }
  async #save({ savePendingKeys = true } = {}) {
    if (!this.writable) {
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB");
      return false;
    }
    const route = this.#route();
    if (route && this.externalDrafts.has(route)) return this.#saveExternal(route, { savePendingKeys });
    const persisted = JSON.parse(this.hostSnapshot);
    for (const [route2, profile] of Object.entries(this.providers)) {
      if (!Object.hasOwn(persisted, route2) && Object.keys(profile).length === 0 && !this.pendingProbeKeys.has(route2) && !this.materializeRoutes.has(route2)) delete this.providers[route2];
    }
    for (const [route2, profile] of Object.entries(this.providers)) {
      if (!route2.trim()) {
        this.app.toast("\u4FDD\u5B58\u5931\u8D25:\u4F9B\u5E94\u5546\u8DEF\u7531\u540D\u4E0D\u80FD\u4E3A\u7A7A");
        return false;
      }
      if (this.draftRoute === route2 && !ROUTE_PATTERN.test(route2)) {
        this.app.toast("\u4FDD\u5B58\u5931\u8D25:\u65B0\u4F9B\u5E94\u5546\u8DEF\u7531\u540D\u683C\u5F0F\u65E0\u6548");
        return false;
      }
      const entry = this.#entry(route2);
      const declared = entry?.declared === true || this.draftRoute === route2;
      if (profile.displayName !== void 0 && !String(profile.displayName).trim()) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u663E\u793A\u540D\u4E0D\u80FD\u4E3A\u7A7A`);
        return false;
      }
      if (profile.baseURL !== void 0 && !String(profile.baseURL).trim()) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684 baseURL \u4E0D\u80FD\u4E3A\u7A7A`);
        return false;
      }
      if (profile.apiKeyEnv !== void 0 && !KEY_REF_OK.test(profile.apiKeyEnv)) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u5BC6\u94A5\u5F15\u7528\u65E0\u6548`);
        return false;
      }
      if (profile.api !== void 0 && !API_PROTOCOLS.includes(profile.api)) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u534F\u8BAE\u4E0D\u53D7\u652F\u6301`);
        return false;
      }
      if (declared && !API_PROTOCOLS.includes(profile.api)) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9\u5FC5\u987B\u9009\u62E9 API \u534F\u8BAE`);
        return false;
      }
      if (declared && !String(profile.baseURL ?? "").trim()) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9\u5FC5\u987B\u586B\u5199 baseURL`);
        return false;
      }
      if (declared && (!Array.isArray(profile.models) || profile.models.length === 0)) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u7684\u81EA\u5B9A\u4E49\u63D0\u4F9B\u65B9\u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u6A21\u578B`);
        return false;
      }
      for (const model of profile.models ?? []) {
        if (!String(model.id ?? "").trim()) {
          this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2} \u6709\u672A\u586B\u5199 id \u7684\u6A21\u578B`);
          return false;
        }
        if (model.reasoningEfforts && model.reasoningEfforts !== false) {
          const declared2 = Object.entries(model.reasoningEfforts);
          if (declared2.some(([level, wire]) => level !== "off" && (typeof wire !== "string" || wire.length === 0))) {
            this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2}/${model.id} \u7684\u975E off \u601D\u8003\u5F3A\u5EA6\u5FC5\u987B\u586B\u5199 wire \u503C`);
            return false;
          }
          if (!declared2.some(([level, wire]) => level !== "off" && typeof wire === "string" && wire.length > 0)) {
            this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route2}/${model.id} \u7684\u81EA\u5B9A\u4E49\u601D\u8003\u80FD\u529B\u81F3\u5C11\u9700\u8981\u4E00\u79CD\u975E off \u5F3A\u5EA6`);
            return false;
          }
        }
      }
    }
    let settingsChanged = false;
    const confirmed = JSON.parse(this.savedSnapshot);
    if (JSON.stringify(this.providers) !== this.hostSnapshot || this.materializeRoutes.size > 0) {
      try {
        const wholeRoutes = /* @__PURE__ */ new Set([...this.draftRoute ? [this.draftRoute] : [], ...this.materializeRoutes]);
        const ops = providerOps(JSON.parse(this.hostSnapshot), this.providers, wholeRoutes);
        const res = await this.app.api.call("settings.mutate", {
          ns: "llm-pi-ai",
          ops,
          expectedRevision: this.revision
        });
        this.revision = res?.revision ?? this.revision;
        this.draftRoute = null;
        this.materializeRoutes.clear();
        this.hostSnapshot = JSON.stringify(this.providers);
        this.initialConfiguredDirectory = new Set(this.configuredDirectory);
        settingsChanged = true;
      } catch (e) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25: ${e.message}`);
        return false;
      }
    }
    for (const route2 of /* @__PURE__ */ new Set([...Object.keys(confirmed), ...Object.keys(this.providers)])) {
      if (this.pendingProbeKeys.has(route2)) continue;
      if (Object.hasOwn(this.providers, route2)) confirmed[route2] = this.providers[route2];
      else delete confirmed[route2];
    }
    this.savedSnapshot = JSON.stringify(confirmed);
    try {
      if (savePendingKeys) {
        for (const [route2, value] of [...this.pendingProbeKeys]) {
          const ref = this.#keyRef(route2);
          await this.app.api.call("credentials.set", { ref, value });
          this.pendingProbeKeys.delete(route2);
          if (Object.hasOwn(this.providers, route2)) confirmed[route2] = this.providers[route2];
          else delete confirmed[route2];
          this.savedSnapshot = JSON.stringify(confirmed);
        }
      }
      await this.#refreshKeys();
      this.app.toast(settingsChanged ? `\u5DF2\u4FDD\u5B58 ${Object.keys(this.providers).length} \u4E2A\u4F9B\u5E94\u5546` : savePendingKeys ? "API \u5BC6\u94A5\u5DF2\u4FDD\u5B58" : "\u914D\u7F6E\u672A\u53D8\u5316");
      return true;
    } catch (e) {
      await this.#refreshKeys();
      this.app.toast(`${settingsChanged ? "\u4F9B\u5E94\u5546\u5DF2\u4FDD\u5B58\uFF1B" : ""}API \u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25: ${e.message}`);
      return false;
    }
  }
  async #saveExternal(route, { savePendingKeys = true } = {}) {
    const entry = this.#entry(route);
    const draft = this.externalDrafts.get(route) ?? {};
    const hostSnapshot = this.externalHostSnapshots.get(route) ?? "{}";
    const savedSnapshot = this.externalSnapshots.get(route) ?? "{}";
    for (const model of draft.models ?? []) {
      if (!String(model.id ?? "").trim()) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route} \u6709\u672A\u586B\u5199 id \u7684\u6A21\u578B`);
        return false;
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        if (model[field] !== void 0 && (!Number.isInteger(model[field]) || model[field] <= 0)) {
          this.app.toast(`\u4FDD\u5B58\u5931\u8D25:${route}/${model.id} \u7684 ${field} \u5FC5\u987B\u662F\u6B63\u6574\u6570`);
          return false;
        }
      }
    }
    let settingsChanged = false;
    if (JSON.stringify(draft) !== hostSnapshot) {
      try {
        const ops = profileOps(entry.settingsPath, JSON.parse(hostSnapshot), draft);
        if (ops.length > 0) {
          const res = await this.app.api.call("settings.mutate", {
            ns: entry.settingsNs,
            ops,
            expectedRevision: this.revisions.get(entry.settingsNs) ?? 0
          });
          this.revisions.set(entry.settingsNs, res?.revision ?? this.revisions.get(entry.settingsNs) ?? 0);
        }
        this.externalHostSnapshots.set(route, JSON.stringify(draft));
        settingsChanged = true;
      } catch (e) {
        this.app.toast(`\u4FDD\u5B58\u5931\u8D25: ${e.message}`);
        return false;
      }
    }
    try {
      if (savePendingKeys && this.pendingProbeKeys.has(route)) {
        await this.app.api.call("credentials.set", { ref: this.#keyRef(route), value: this.pendingProbeKeys.get(route) });
        this.pendingProbeKeys.delete(route);
      }
      this.externalSnapshots.set(route, JSON.stringify(draft));
      this.initialConfiguredDirectory.add(route);
      await this.#refreshKeys();
      this.app.toast(settingsChanged ? `\u5DF2\u4FDD\u5B58 ${entry.displayName || route}` : savePendingKeys ? "API \u5BC6\u94A5\u5DF2\u4FDD\u5B58" : "\u914D\u7F6E\u672A\u53D8\u5316");
      return true;
    } catch (e) {
      this.externalSnapshots.set(route, savedSnapshot);
      await this.#refreshKeys();
      this.app.toast(`${settingsChanged ? "\u4F9B\u5E94\u5546\u5DF2\u4FDD\u5B58\uFF1B" : ""}API \u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25: ${e.message}`);
      return false;
    }
  }
  #dirty() {
    if (JSON.stringify(this.providers) !== this.savedSnapshot || this.materializeRoutes.size > 0 || this.pendingProbeKeys.size > 0) return true;
    for (const [route, draft] of this.externalDrafts) if (JSON.stringify(draft) !== (this.externalSnapshots.get(route) ?? "{}")) return true;
    return false;
  }
  /** Throw away the in-memory edits and restore the last fully successful state. */
  async #discard() {
    for (const [route, hostSnapshot] of this.externalHostSnapshots) {
      const savedSnapshot = this.externalSnapshots.get(route) ?? "{}";
      if (hostSnapshot === savedSnapshot) continue;
      const entry = this.#entry(route);
      try {
        const ops = profileOps(entry.settingsPath, JSON.parse(hostSnapshot), JSON.parse(savedSnapshot));
        if (ops.length > 0) {
          const res = await this.app.api.call("settings.mutate", {
            ns: entry.settingsNs,
            ops,
            expectedRevision: this.revisions.get(entry.settingsNs) ?? 0
          });
          this.revisions.set(entry.settingsNs, res?.revision ?? this.revisions.get(entry.settingsNs) ?? 0);
        }
        this.externalHostSnapshots.set(route, savedSnapshot);
      } catch (e) {
        this.app.toast(`\u653E\u5F03\u4FEE\u6539\u5931\u8D25: ${e.message}`);
        return false;
      }
    }
    if (this.hostSnapshot !== this.savedSnapshot) {
      try {
        const target = JSON.parse(this.savedSnapshot);
        const ops = providerOps(JSON.parse(this.hostSnapshot), target);
        if (ops.length > 0) {
          const res = await this.app.api.call("settings.mutate", { ns: "llm-pi-ai", ops, expectedRevision: this.revision });
          this.revision = res?.revision ?? this.revision;
        }
        this.hostSnapshot = this.savedSnapshot;
      } catch (e) {
        this.app.toast(`\u653E\u5F03\u4FEE\u6539\u5931\u8D25: ${e.message}`);
        return false;
      }
    }
    this.providers = JSON.parse(this.savedSnapshot);
    for (const [route, snapshot] of this.externalSnapshots) {
      this.externalDrafts.set(route, JSON.parse(snapshot));
      this.externalHostSnapshots.set(route, snapshot);
    }
    this.configuredDirectory = new Set(this.initialConfiguredDirectory);
    this.materializeRoutes.clear();
    this.pendingProbeKeys.clear();
    this.#syncRoutes();
    this.draftRoute = null;
    this.addMode = false;
    this.modelsSel = -1;
    this.sub = null;
    this.sel = this.routes.length === 0 ? 0 : Math.min(this.sel, this.routes.length - 1);
    this.#rebuild();
    this.app.redraw();
    return true;
  }
  /** Leave the provider form for another level. With unsaved changes this asks
   *  保存/不保存/取消 first; a failed save keeps the user on the form. */
  #leaveForm(after) {
    if (!this.#dirty()) {
      after();
      return;
    }
    const w = Math.min(64, this.app.screen.w - 8);
    const popup = new Popup({
      x: Math.floor((this.app.screen.w - w) / 2),
      y: Math.floor((this.app.screen.h - 10) / 2),
      w,
      h: 10,
      title: "\u672A\u4FDD\u5B58\u7684\u4FEE\u6539",
      lines: [
        [{ t: " \u4F9B\u5E94\u5546\u914D\u7F6E\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\u3002", fg: K.TXT }],
        [{ t: " \u8FD4\u56DE\u4F9B\u5E94\u5546\u9009\u62E9\u4E4B\u524D,\u8981\u4FDD\u5B58\u5417?", fg: K.TXT }]
      ],
      buttons: [
        { label: "\u{1F4BE} \u4FDD\u5B58\u5E76\u8FD4\u56DE", action: "save" },
        { label: "\u4E0D\u4FDD\u5B58", action: "discard" },
        { label: "\u53D6\u6D88", action: "cancel" }
      ],
      onAction: async (btn) => {
        this.app.closeOverlay();
        this.app.focus(this.app.fullBuffer ?? this.app.chat);
        if (btn?.action === "cancel") return;
        if (btn?.action === "save") {
          const ok = await this.#save();
          if (!ok) return;
        } else if (btn?.action === "discard") {
          if (!await this.#discard()) return;
        } else {
          return;
        }
        after();
      }
    });
    this.app.overlay = popup;
    this.app.focus(popup);
    this.app.redraw();
  }
  #confirmDelete(prompt, action) {
    const w = Math.max(18, Math.min(60, this.app.screen.w - 4));
    this.app.overlay = new Popup({
      x: Math.max(0, Math.floor((this.app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor(this.app.screen.h / 2) - 3),
      w,
      h: Math.min(7, this.app.screen.h),
      title: "\u786E\u8BA4\u5220\u9664",
      lines: [[{ t: " " + prompt, fg: K.WARN }]],
      buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u5220\u9664", action: "delete" }],
      onAction: (btn) => {
        this.app.closeOverlay();
        if (btn?.action === "delete") return action();
      }
    });
    this.app.redraw();
  }
  async #unconfigureExternalProvider() {
    const route = this.#route();
    const entry = this.#entry(route);
    if (!route || !entry || entry.settingsNs === "llm-pi-ai" || entry.settingsPath.length === 0 || !this.externalUserConfigured.has(route)) return;
    if (this.#dirty()) {
      this.app.toast("\u8BF7\u5148\u4FDD\u5B58\u6216\u653E\u5F03\u5176\u4ED6\u4FEE\u6539\uFF0C\u518D\u53D6\u6D88\u914D\u7F6E\u63D0\u4F9B\u65B9");
      return;
    }
    this.#confirmDelete(`\u53D6\u6D88\u914D\u7F6E ${entry.displayName || route}\uFF1F\u8FD9\u4F1A\u79FB\u9664\u8BE5\u63D0\u4F9B\u65B9\u7684\u7528\u6237\u5C42\u8BBE\u7F6E\uFF0C\u4F46\u4E0D\u4F1A\u6E05\u9664\u5168\u5C40 API \u5BC6\u94A5\u3002`, async () => {
      try {
        const res = await this.app.api.call("settings.mutate", {
          ns: entry.settingsNs,
          ops: [{ op: "unset", path: entry.settingsPath }],
          expectedRevision: this.revisions.get(entry.settingsNs) ?? 0
        });
        this.revisions.set(entry.settingsNs, res?.revision ?? this.revisions.get(entry.settingsNs) ?? 0);
      } catch (e) {
        this.app.toast(`\u53D6\u6D88\u914D\u7F6E\u5931\u8D25: ${e.message}`);
        return;
      }
      this.externalUserConfigured.delete(route);
      this.externalDrafts.set(route, {});
      this.externalSnapshots.set(route, "{}");
      this.externalHostSnapshots.set(route, "{}");
      this.externalInherited.set(route, {});
      this.configuredDirectory.delete(route);
      this.initialConfiguredDirectory.delete(route);
      this.pendingProbeKeys.delete(route);
      this.#syncRoutes();
      this.sel = this.routes.length === 0 ? 0 : Math.min(this.sel, this.routes.length - 1);
      this.modelsSel = -1;
      this.sub = null;
      await this.#refreshKeys();
      this.app.toast(`\u5DF2\u53D6\u6D88\u914D\u7F6E ${entry.displayName || route}\uFF1B\u5168\u5C40 API \u5BC6\u94A5\u672A\u6539\u53D8`);
      this.#rebuild();
      this.app.redraw();
    });
  }
  async #deleteProvider() {
    const route = this.#route();
    if (!route) return;
    if (this.#dirty()) {
      this.app.toast("\u8BF7\u5148\u4FDD\u5B58\u6216\u653E\u5F03\u5176\u4ED6\u4FEE\u6539\uFF0C\u518D\u5220\u9664\u4F9B\u5E94\u5546");
      return;
    }
    this.#confirmDelete(`\u5220\u9664\u4F9B\u5E94\u5546 ${route}\uFF1F\u6B64\u64CD\u4F5C\u4F1A\u7ACB\u5373\u4FDD\u5B58\u3002`, async () => {
      const profile = this.#profile(route);
      const ref = this.#keyRef(route);
      const managedCredential = profile.apiKeyEnv === deriveKeyRef(route) && this.keyStatus?.[ref]?.configured === true && this.keyStatus[ref].writable === true;
      if (managedCredential) {
        this.pendingCredentialCleanups.set(ref, { route, error: "\u7B49\u5F85\u786E\u8BA4\u4F9B\u5E94\u5546\u5220\u9664", reconcile: true });
        if (!this.#persistCredentialCleanups()) {
          this.pendingCredentialCleanups.delete(ref);
          this.app.toast("\u5220\u9664\u5931\u8D25: \u65E0\u6CD5\u8BB0\u5F55\u6258\u7BA1\u5BC6\u94A5\u6E05\u7406\u4EFB\u52A1");
          return;
        }
      }
      let providerState = null;
      try {
        const res = await this.app.api.call("settings.mutate", {
          ns: "llm-pi-ai",
          ops: [{ op: "unset", path: ["providers", route] }],
          expectedRevision: this.revision
        });
        this.revision = res?.revision ?? this.revision;
        providerState = this.#providerStateFromProfiles(res?.value?.providers ?? Object.fromEntries(
          Object.entries(this.resolvedProviders).filter(([candidate]) => candidate !== route)
        ));
      } catch (e) {
        const conflict = e?.code === "settings-conflict";
        if (managedCredential && conflict) {
          const task = this.pendingCredentialCleanups.get(ref);
          this.pendingCredentialCleanups.delete(ref);
          if (!this.#persistCredentialCleanups()) this.pendingCredentialCleanups.set(ref, task);
          this.app.toast(`\u5220\u9664\u5931\u8D25: ${e.message}`);
          this.#rebuild();
          this.app.redraw();
          return;
        }
        if (!managedCredential) {
          this.app.toast(`\u5220\u9664\u5931\u8D25: ${e.message}`);
          return;
        }
        this.pendingCredentialCleanups.set(ref, { route, error: `\u7B49\u5F85\u6838\u5BF9\u5220\u9664\u7ED3\u679C: ${String(e?.message ?? e).slice(0, 500)}`, reconcile: true });
        this.#persistCredentialCleanups();
        try {
          providerState = this.#providerStateFromDescription(await this.app.api.call("settings.describe"));
        } catch {
        }
        if (providerState === null) {
          const failure = { ref, route, error: this.pendingCredentialCleanups.get(ref).error, reconcile: true };
          this.app.toast(`\u5220\u9664\u7ED3\u679C\u5F85\u6838\u5BF9: ${e.message}`);
          this.#showCredentialCleanupFailure(failure);
          this.#rebuild();
          this.app.redraw();
          return;
        }
        if (providerState.routes.has(route)) {
          if (providerState.refs.has(ref)) {
            const task = this.pendingCredentialCleanups.get(ref);
            this.pendingCredentialCleanups.delete(ref);
            if (!this.#persistCredentialCleanups()) this.pendingCredentialCleanups.set(ref, task);
            this.app.toast(`\u5220\u9664\u5931\u8D25: ${e.message}`);
          } else {
            const failure = { ref, route, error: `\u8DEF\u7531 ${route} \u4ECD\u5B58\u5728\uFF0C\u65E0\u6CD5\u81EA\u52A8\u786E\u8BA4\u65E7\u5BC6\u94A5\u53EF\u6E05\u7406`, reconcile: true };
            this.pendingCredentialCleanups.set(ref, { route, error: failure.error, reconcile: true });
            this.#persistCredentialCleanups();
            this.app.toast(`\u5220\u9664\u7ED3\u679C\u5F85\u6838\u5BF9: ${e.message}`);
            this.#showCredentialCleanupFailure(failure);
          }
          this.#rebuild();
          this.app.redraw();
          return;
        }
      }
      delete this.providers[route];
      delete this.resolvedProviders[route];
      delete this.inheritedProviders[route];
      this.configuredDirectory.delete(route);
      this.initialConfiguredDirectory.delete(route);
      this.materializeRoutes.delete(route);
      this.pendingProbeKeys.delete(route);
      this.#syncRoutes();
      this.sel = this.routes.length === 0 ? 0 : Math.min(this.sel, this.routes.length - 1);
      this.modelsSel = -1;
      this.savedSnapshot = JSON.stringify(this.providers);
      this.hostSnapshot = this.savedSnapshot;
      const cleanup = managedCredential ? await this.#retryPendingCredentialCleanups({ onlyRef: ref, notify: false, providerState }) : { completed: [], failed: [] };
      await this.#refreshKeys();
      if (cleanup.failed.length > 0) {
        this.app.toast(`\u4F9B\u5E94\u5546\u5DF2\u5220\u9664\uFF1B\u6258\u7BA1\u5BC6\u94A5\u5F85\u6E05\u7406: ${cleanup.failed[0].error}`);
        this.#showCredentialCleanupFailure(cleanup.failed[0]);
      } else {
        this.app.toast(`\u5DF2\u5220\u9664\u4F9B\u5E94\u5546 ${route}`);
      }
      this.#rebuild();
      this.app.redraw();
    });
  }
  async #scan() {
    const route = this.#route();
    if (!route) return;
    const p = this.#profile(route);
    const entry = this.#entry(route);
    const declared = entry?.declared === true || this.draftRoute === route;
    if (declared && p.api === "anthropic-messages") {
      this.app.toast("anthropic-messages \u4E0D\u652F\u6301\u81EA\u52A8\u5217\u51FA\u6A21\u578B\uFF0C\u8BF7\u624B\u52A8\u6DFB\u52A0\u6A21\u578B ID");
      return;
    }
    const base = String(p.baseURL ?? "").replace(/\/+$/, "");
    this.scanning = true;
    this.scanMode = true;
    this.scanItems = [];
    this.scanCursor = 0;
    this.#rebuild();
    this.app.redraw();
    try {
      const res = await this.app.api.call("llm.discoverModels", {
        settingsNs: this.#namespace(route),
        provider: route,
        ...p.api ? { api: p.api } : {},
        ...base ? { baseURL: base } : {},
        ...this.pendingProbeKeys.has(route) ? { apiKey: this.pendingProbeKeys.get(route) } : {}
      });
      const seen = /* @__PURE__ */ new Set();
      this.scanItems = (res?.models ?? []).flatMap((entry2) => {
        if (!entry2 || typeof entry2 !== "object") return [];
        const id = String(entry2.id ?? "").trim();
        if (!id || seen.has(id)) return [];
        seen.add(id);
        return [{
          id,
          ...typeof entry2.name === "string" && entry2.name ? { name: entry2.name } : {},
          ...Number.isInteger(entry2.contextWindow) && entry2.contextWindow > 0 ? { contextWindow: entry2.contextWindow } : {},
          ...Number.isInteger(entry2.maxTokens) && entry2.maxTokens > 0 ? { maxTokens: entry2.maxTokens } : {}
        }];
      });
      this.scanSel = new Set(this.scanItems.map((model) => model.id));
      if (this.scanItems.length === 0) this.app.toast("\u626B\u63CF\u5B8C\u6210:\u672A\u53D1\u73B0\u6A21\u578B");
      else this.app.toast(`\u53D1\u73B0 ${this.scanItems.length} \u4E2A\u6A21\u578B,\u7A7A\u683C\u52FE\u9009,Enter \u6DFB\u52A0`);
    } catch (e) {
      this.app.toast(`\u626B\u63CF\u5931\u8D25:${String(e.message ?? e).replace(/^[^:]+:\s*/, "")}`);
      this.scanMode = false;
    }
    this.scanning = false;
    this.#rebuild();
    this.app.redraw();
  }
  #scanCommit() {
    const route = this.#route();
    if (!route) return;
    if (!this.writable) {
      this.scanMode = false;
      this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB\uFF0C\u672A\u6DFB\u52A0\u53D1\u73B0\u7ED3\u679C");
      this.#rebuild();
      this.app.redraw();
      return;
    }
    const existing = new Set(this.#models(route).map((m) => m.id));
    const selected = this.scanItems.filter((model) => this.scanSel.has(model.id) && !existing.has(model.id));
    let added = 0;
    for (const m of selected) {
      this.#models(route, { mutable: true }).push({
        id: m.id,
        ...m.name != null ? { name: m.name } : {},
        ...m.contextWindow != null ? { contextWindow: m.contextWindow } : {},
        ...m.maxTokens != null ? { maxTokens: m.maxTokens } : {}
      });
      added++;
    }
    this.scanMode = false;
    this.app.toast(`\u5DF2\u6DFB\u52A0 ${added} \u4E2A\u6A21\u578B\uFF08\u4FDD\u5B58\u540E\u751F\u6548\uFF09`);
    this.#rebuild();
    this.app.redraw();
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "char" && ev.key === "c" && !ev.ctrl && this.pendingCredentialCleanups.size > 0) {
      const [ref, task] = this.pendingCredentialCleanups.entries().next().value;
      this.#showCredentialCleanupFailure({ ref, ...task });
      return true;
    }
    if (this.addMode) {
      if (ev.name === "escape") {
        this.addMode = false;
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "up" || ev.name === "char" && ev.key === "k" && !ev.ctrl) {
        this.addCursor = wrapIndex(this.addCursor - 1, this.addItems.length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "down" || ev.name === "char" && ev.key === "j" && !ev.ctrl) {
        this.addCursor = wrapIndex(this.addCursor + 1, this.addItems.length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "enter") {
        this.#activateAddItem();
        return true;
      }
      return false;
    }
    if (this.scanMode) {
      if (ev.name === "escape") {
        this.scanMode = false;
        this.#rebuild();
        return true;
      }
      if (ev.name === "up") {
        this.scanCursor = wrapIndex(this.scanCursor - 1, this.scanItems.length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "down") {
        this.scanCursor = wrapIndex(this.scanCursor + 1, this.scanItems.length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "char" && ev.key === " " && !ev.ctrl) {
        const m = this.scanItems[this.scanCursor];
        if (m) {
          if (this.scanSel.has(m.id)) this.scanSel.delete(m.id);
          else this.scanSel.add(m.id);
        }
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "enter") {
        this.#scanCommit();
        return true;
      }
      return false;
    }
    if (this.sub != null) {
      if (ev.name === "escape") {
        this.sub = null;
        this.#rebuild();
        return true;
      }
      if (ev.name === "up" || ev.name === "char" && ev.key === "k" && !ev.ctrl) {
        this.sub.cursor = wrapIndex(this.sub.cursor - 1, this.#subItems().length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "down" || ev.name === "char" && ev.key === "j" && !ev.ctrl) {
        this.sub.cursor = wrapIndex(this.sub.cursor + 1, this.#subItems().length);
        this.#rebuild();
        this.app.redraw();
        return true;
      }
      if (ev.name === "enter") {
        this.#activateItem();
        return true;
      }
      return false;
    }
    if (ev.name === "escape") {
      if (this.mode === "form") {
        this.#leaveForm(() => {
          this.mode = "list";
          this.sub = null;
          this.#rebuild();
          this.app.redraw();
        });
        return true;
      }
      return false;
    }
    if (ev.name === "up" || ev.name === "char" && ev.key === "k" && !ev.ctrl) {
      if (this.mode === "list") this.sel = wrapIndex(this.sel - 1, this.routes.length + 1);
      else this.formIdx = wrapIndex(this.formIdx - 1, this.formItems.length);
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (ev.name === "down" || ev.name === "char" && ev.key === "j" && !ev.ctrl) {
      if (this.mode === "list") this.sel = wrapIndex(this.sel + 1, this.routes.length + 1);
      else this.formIdx = wrapIndex(this.formIdx + 1, this.formItems.length);
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (ev.name === "tab" && this.mode === "form" && this.sub == null) {
      const it = this.formItems[this.formIdx];
      if (it?.cycle?.length && !this.writable) {
        this.app.toast("\u6A21\u578B\u914D\u7F6E\u4E3A\u53EA\u8BFB");
        return true;
      }
      if (it?.cycle?.length) {
        const cur = String(it.value ?? "");
        const idx = it.cycle.indexOf(cur);
        const value = it.cycle[(idx + 1) % it.cycle.length];
        const profile = this.#draftProfile(this.#route());
        if ((it.key === "api" || it.key === "reasoning") && value === "") delete profile[it.key];
        else profile[it.key] = value;
        if (it.key === "api" && value !== "openai-completions") this.#stripCompat(this.#route());
      } else if (this.formItems.length > 0) {
        this.formIdx = wrapIndex(this.formIdx + 1, this.formItems.length);
      }
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (ev.name === "right" || ev.name === "char" && ev.key === "l" && !ev.ctrl || ev.name === "tab") {
      if (this.#route() != null && this.mode !== "form") {
        this.mode = "form";
        this.#rebuild();
      }
      this.app.redraw();
      return true;
    }
    if (ev.name === "enter") {
      this.#activateItem();
      return true;
    }
    if (ev.name === "left" || ev.name === "char" && ev.key === "h" && !ev.ctrl || ev.name === "backtab") {
      if (this.mode === "form") {
        this.#leaveForm(() => {
          this.mode = "list";
          this.sub = null;
          this.#rebuild();
          this.app.redraw();
        });
      }
      this.app.redraw();
      return true;
    }
    return false;
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") {
      this.formView.scroll(-3);
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.formView.scroll(3);
      return true;
    }
    if (ev.kind !== "press" || ev.button !== 0) return false;
    if (ev.x < this.x + 26) {
      const idx = ev.y - this.listView.y + this.listView.scrollY;
      if (idx >= 0 && idx <= this.routes.length) {
        if (this.mode === "form") {
          if (idx === this.sel) return true;
          if (idx === this.routes.length) {
            this.#leaveForm(() => this.#openAddProvider());
          } else {
            this.#leaveForm(() => {
              this.sel = idx;
              this.mode = "form";
              this.formIdx = 0;
              this.modelsSel = -1;
              this.sub = null;
              this.#rebuild();
              this.app.redraw();
            });
          }
          return true;
        }
        this.sel = idx;
        this.#activateItem();
        return true;
      }
      return false;
    }
    if (!this.formView.inside(ev.x, ev.y)) return false;
    const line = ev.y - this.formView.y + this.formView.scrollY;
    const target = this.formClickMap[line];
    if (!target) return true;
    if (target.type === "add" && this.addMode) {
      this.addCursor = target.index;
      this.#activateAddItem();
      return true;
    }
    if (target.type === "cleanup") {
      const task = this.pendingCredentialCleanups.get(target.ref);
      if (task) this.#showCredentialCleanupFailure({ ref: target.ref, ...task });
      return true;
    }
    if (target.type === "scan") {
      const m = this.scanItems[target.index];
      if (!m) return false;
      this.scanCursor = target.index;
      if (this.scanSel.has(m.id)) this.scanSel.delete(m.id);
      else this.scanSel.add(m.id);
      this.#rebuild();
      this.app.redraw();
      return true;
    }
    if (target.type === "item" && target.sub && this.sub != null) {
      this.sub.cursor = target.index;
      this.#activateItem();
      return true;
    }
    if (target.type === "item" && !target.sub && this.sub == null && target.index < this.formItems.length) {
      this.formIdx = target.index;
      this.mode = "form";
      this.#activateItem();
      return true;
    }
    return false;
  }
};
function flattenJson(value, path, out, depth = 0) {
  if (depth === 0 && path.length === 0 && value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) flattenJson(value[k], [k], out, 1);
    return;
  }
  if (depth > 6) {
    out.push({ path, value: value === null ? null : String(value).slice(0, 80), type: typeof value });
    return;
  }
  if (value !== null && typeof value === "object") {
    out.push({ path, value, type: Array.isArray(value) ? "array" : "object" });
    for (const k of Object.keys(value)) {
      flattenJson(value[k], [...path, k], out, depth + 1);
    }
  } else {
    out.push({ path, value, type: value === null ? "null" : typeof value });
  }
}
function applyOps(base, ops) {
  const value = JSON.parse(JSON.stringify(base ?? {}));
  for (const op of ops) {
    if (op.op === "set") {
      let cur = value;
      for (let i = 0; i < op.path.length - 1; i++) {
        cur[op.path[i]] ??= {};
        cur = cur[op.path[i]];
      }
      cur[op.path[op.path.length - 1]] = op.value;
    } else if (op.op === "unset") {
      let cur = value;
      for (let i = 0; i < op.path.length - 1; i++) {
        if (typeof cur[op.path[i]] !== "object" || cur[op.path[i]] === null) break;
        cur = cur[op.path[i]];
      }
      delete cur[op.path[op.path.length - 1]];
    }
  }
  return value;
}
function parseScalar(s) {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return s;
}
var SubagentPanel = class extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.parentId = null;
    this.entries = [];
    this.selIdx = 0;
    this.log = [];
    const listW = 30;
    this.list = new ScrollView({ x: this.x + 1, y: this.y + 1, w: listW, h: this.h - 3, showScrollbar: true });
    this.view = new ScrollView({ x: this.x + listW + 1, y: this.y + 1, w: this.w - listW - 2, h: this.h - 3, showScrollbar: true, autoScroll: true });
    this.input = new Input({ x: this.x + listW + 1, y: this.y + this.h - 2, w: this.w - listW - 2, h: 1, placeholder: "\u7ED9\u9009\u4E2D\u5B50\u4EE3\u7406\u53D1\u6D88\u606F\u2026\uFF08continuable\uFF09", onEnter: (v) => this.send(v) });
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    const listW = 30;
    this.list.x = x + 1;
    this.list.y = y + 1;
    this.list.w = listW;
    this.list.h = h - 3;
    this.view.x = x + listW + 1;
    this.view.y = y + 1;
    this.view.w = w - listW - 2;
    this.view.h = h - 3;
    this.input.x = x + listW + 1;
    this.input.y = y + h - 2;
    this.input.w = w - listW - 2;
  }
  async load(parentId) {
    const token = (this.loadToken ?? 0) + 1;
    this.loadToken = token;
    this.parentId = parentId;
    try {
      const res = await this.app.api.call("subagent.list", { parentSessionId: parentId });
      if (this.parentId !== parentId || this.loadToken !== token) return;
      this.entries = res.entries ?? [];
      this.parentAvailable = res.parentAvailable;
    } catch (e) {
      this.entries = [];
      this.app.toast(`\u5B50\u4EE3\u7406\u5217\u8868\u5931\u8D25: ${e.message}`);
    }
    this.selIdx = 0;
    this.#rebuildList();
    await this.selectChild(0);
  }
  #rebuildList() {
    const lines = this.entries.length === 0 ? [[{ t: "\uFF08\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u5B50\u4EE3\u7406\uFF09", fg: K.FAINT }], [{ t: "\u5B50\u4EE3\u7406\u7531 agent \u7684 subagent \u5DE5\u5177\u521B\u5EFA", fg: K.FAINT }]] : this.entries.map((e) => [
      { t: `${e.activity === "running" ? "\u25CF" : "\u25CB"} `, fg: e.activity === "running" ? K.OK : K.FAINT },
      { t: truncate(e.label ?? e.id.slice(0, 8), 22), fg: K.TXT, bold: true },
      { t: " " + e.mode, fg: K.DIM }
    ]);
    this.list.setLines(lines);
  }
  async selectChild(i) {
    if (i < 0 || i >= this.entries.length) {
      this.view.setLines([[{ t: "\u9009\u62E9\u5DE6\u4FA7\u5B50\u4EE3\u7406\u67E5\u770B\u5386\u53F2", fg: K.FAINT }]]);
      this.selIdx = Math.max(0, i);
      return;
    }
    this.selIdx = i;
    const parentId = this.parentId;
    const child = this.entries[i];
    this.view.setLines([[{ t: `\u52A0\u8F7D ${child.id.slice(0, 8)} \u5386\u53F2\u2026`, fg: K.DIM }]]);
    try {
      const h = await this.app.api.call("subagent.history", {
        parentSessionId: parentId,
        childSessionId: child.id,
        mode: child.mode,
        maxMessages: 100
      });
      if (this.parentId !== parentId || this.entries[this.selIdx]?.id !== child.id) return;
      const projections = h.projections?.values ?? h.projections ?? {};
      const identity = projections.subagent;
      const timing = projections.subagentTiming;
      const elapsed = (timing?.settledMs ?? 0) + (timing?.active ? Math.max(0, Date.now() - timing.active.since) : 0);
      const lines = [[{ t: `${identity?.label ?? child.label ?? child.id} \u2014 ${h.events.length} \u4E8B\u4EF6${elapsed ? ` \xB7 ${fmtMs(elapsed)}` : ""}`, fg: K.ACCENT, bold: true }], [{ t: `\u6A21\u5F0F ${identity?.mode ?? child.mode}${timing?.active ? " \xB7 \u25CF\u8FD0\u884C\u4E2D" : ""}`, fg: K.DIM }]];
      const goal = projections.goal?.goal ?? projections.goal;
      if (goal?.objective) lines.push([{ t: `\u76EE\u6807: ${truncate(goal.objective, this.view.w - 10)} \xB7 ${goal.phase ?? "active"}`, fg: K.WARN }]);
      const todos = projections.todos ?? [];
      if (todos.length) lines.push([{ t: `\u4EFB\u52A1: ${todos.filter((t) => t.status === "completed").length}/${todos.length} \u5B8C\u6210`, fg: K.DIM }]);
      lines.push([{ t: "" }]);
      for (const { event } of h.events.slice(-200)) {
        const d = event.data ?? {};
        let summary = "";
        switch (event.type) {
          case "user/message":
            summary = "\u276F " + String(partsText(d.content)).slice(0, 90);
            break;
          case "assistant/message":
            summary = "\u25C9 " + String(partsText(d.message?.content)).slice(0, 90);
            break;
          case "assistant/chunk": {
            const ch = d.chunk ?? {};
            if (ch.type === "text-delta") summary = "\u25B8 " + String(ch.delta ?? "").slice(0, 90);
            else if (ch.type === "block-start") summary = `\u25B8 [${ch.blockType}]`;
            else summary = "\u25B8 \u2026";
            break;
          }
          case "tool/call":
            summary = `\u2699 ${d.name ?? "tool"} ${String(d.arguments ?? "").slice(0, 60)}`;
            break;
          case "tool/result":
            summary = "\u21B3 \u7ED3\u679C " + String(partsText(d.message?.content)).slice(0, 60);
            break;
          case "step/start":
            summary = `\u2014 step ${d.step ?? ""}`;
            break;
          case "step/end":
            summary = "\u2014 step end";
            break;
          default:
            summary = event.type;
        }
        lines.push([{ t: `#${event.seq}`, fg: K.FAINT }, { t: "  " + truncate(summary, this.view.w - 14), fg: K.TXT }]);
      }
      this.view.setLines(lines);
    } catch (e) {
      this.view.setLines([[{ t: `\u5386\u53F2\u52A0\u8F7D\u5931\u8D25: ${e.message}`, fg: K.ERR }]]);
    }
    this.app.redraw();
  }
  async send(text) {
    const child = this.entries[this.selIdx];
    if (!child) {
      this.app.toast("\u5148\u9009\u62E9\u5B50\u4EE3\u7406");
      return;
    }
    try {
      await this.app.api.call("subagent.prompt", {
        parentSessionId: this.parentId,
        childSessionId: child.id,
        mode: "continuable",
        content: [{ type: "text", text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      this.app.toast(`\u5DF2\u53D1\u9001\u7ED9 ${child.id.slice(0, 8)}`);
    } catch (e) {
      this.app.toast(`\u53D1\u9001\u5931\u8D25: ${e.message}`);
    }
  }
  async interrupt() {
    const child = this.entries[this.selIdx];
    if (!child) return;
    try {
      await this.app.api.call("subagent.interrupt", { parentSessionId: this.parentId, childSessionId: child.id, mode: "continuable" });
      this.app.toast("\u5DF2\u8BF7\u6C42\u4E2D\u65AD");
      this.load(this.parentId);
    } catch (e) {
      this.app.toast(`\u4E2D\u65AD\u5931\u8D25: ${e.message}`);
    }
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const mid = this.x + 30;
    screen.vline(mid, this.y, this.y + this.h - 1, "\u2502", { fg: T.BORDER });
    screen.text(this.x + 1, this.y, " \u5B50\u4EE3\u7406 \u2014 \u70B9\u51FB\u9009\u62E9\uFF0Cx \u4E2D\u65AD\uFF0CEsc \u8FD4\u56DE", { fg: K.DIM });
    this.list.render(screen);
    this.view.render(screen);
    screen.hline(this.x + 31, this.x + this.w - 1, this.y + this.h - 2, "\u2500", { fg: 3818060 });
    this.input.render(screen);
  }
  onMouse(ev) {
    if (ev.x < this.x + 30) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.list.y + this.list.scrollY;
        if (idx >= 0 && idx < this.entries.length) {
          this.selectChild(idx);
          return true;
        }
      }
      return this.list.onMouse(ev);
    }
    if (this.input.inside(ev.x, ev.y)) return this.input.onMouse(ev);
    return this.view.onMouse(ev);
  }
  onKey(ev) {
    if (ev.type === "text") {
      this.input.insert(ev.text);
      this.app.redraw();
      return true;
    }
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
      return true;
    }
    if (ev.name === "char" && ev.key === "x" && !ev.ctrl) {
      this.interrupt();
      return true;
    }
    if (ev.name === "char" && ev.key === "r" && !ev.ctrl) {
      this.selectChild(this.selIdx);
      return true;
    }
    if (ev.name === "up" || ev.name === "down") {
      if (this.entries.length === 0) return false;
      const next = wrapIndex(this.selIdx + (ev.name === "up" ? -1 : 1), this.entries.length);
      this.selectChild(next);
      return true;
    }
    if (this.input.onKey(ev)) {
      this.app.redraw();
      return true;
    }
    return false;
  }
};
function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return texts.join(" ");
}
var SkillsPanel = class extends Widget {
  constructor(app) {
    super({ x: 30, y: 0, w: app.screen.w - 30, h: app.screen.h - 1 });
    this.app = app;
    this.skills = [];
    this.selIdx = 0;
    this.list = new ScrollView({ x: this.x + 1, y: this.y + 1, w: 30, h: this.h - 2, showScrollbar: true });
    this.detail = new ScrollView({ x: this.x + 32, y: this.y + 1, w: this.w - 33, h: this.h - 2, showScrollbar: true });
  }
  relayout(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.list.x = x + 1;
    this.list.y = y + 1;
    this.list.w = 30;
    this.list.h = h - 2;
    this.detail.x = x + 32;
    this.detail.y = y + 1;
    this.detail.w = w - 33;
    this.detail.h = h - 2;
  }
  async load() {
    const sessionId = this.app.currentSession;
    try {
      const r = await this.app.api.call("skill.list", { sessionId });
      if (sessionId !== this.app.currentSession) return;
      this.skills = r.skills ?? [];
    } catch (e) {
      this.skills = [];
      this.app.toast(`\u6280\u80FD\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
    }
    this.select(0);
  }
  select(i) {
    this.selIdx = Math.max(0, Math.min(this.skills.length - 1, i));
    this.list.setLines(this.skills.map((k2) => [
      { t: k2.modelInvocable ? "\u26A1" : "  ", fg: k2.modelInvocable ? K.WARN : K.FAINT },
      { t: " " + truncate(k2.name, 26), fg: K.TXT, bold: true }
    ]));
    const k = this.skills[this.selIdx];
    if (!k) {
      this.detail.setLines([[{ t: "\uFF08\u672C\u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u6280\u80FD\uFF09", fg: K.FAINT }]]);
      this.app.redraw();
      return;
    }
    const lines = [];
    lines.push([{ t: k.name, fg: K.ACCENT, bold: true, underline: true }]);
    if (k.modelInvocable) lines.push([{ t: "\u26A1 \u6A21\u578B\u53EF\u4E3B\u52A8\u8C03\u7528", fg: K.WARN }]);
    lines.push([{ t: "" }]);
    for (const ln of renderMd(k.description ?? "", this.detail.w - 2)) lines.push(ln);
    if (k.whenToUse) {
      lines.push([{ t: "" }, { t: "\u4F55\u65F6\u4F7F\u7528:", fg: K.DIM, underline: true }]);
      for (const ln of renderMd(k.whenToUse, this.detail.w - 2)) lines.push(ln);
    }
    lines.push([{ t: "" }, { t: "\u6309 c \u590D\u5236\u6280\u80FD\u540D \xB7 Esc \u8FD4\u56DE", fg: K.FAINT }]);
    this.detail.setLines(lines);
    this.app.redraw();
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    screen.vline(this.x + 31, this.y, this.y + this.h - 1, "\u2502", { fg: K.BORDER });
    screen.text(this.x + 1, this.y, ` \u6280\u80FD (${this.skills.length}) \u2014 \u70B9\u51FB\u67E5\u770B\u8BE6\u60C5`, { fg: K.DIM });
    this.list.render(screen);
    this.detail.render(screen);
  }
  onMouse(ev) {
    if (ev.x < this.x + 31) {
      if (ev.kind === "press" && ev.button === 0) {
        const idx = ev.y - this.list.y + this.list.scrollY;
        if (idx >= 0 && idx < this.skills.length) {
          this.select(idx);
          return true;
        }
      }
      return this.list.onMouse(ev);
    }
    return this.detail.onMouse(ev);
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "escape") {
      this.app.closeFullBuffer?.() ?? this.app.setMode?.("chat");
      return true;
    }
    if (ev.name === "up" || ev.name === "down") {
      if (this.skills.length === 0) return false;
      const next = wrapIndex(this.selIdx + (ev.name === "up" ? -1 : 1), this.skills.length);
      this.select(next);
      return true;
    }
    if (ev.name === "char" && ev.key === "c" && !ev.ctrl && this.skills[this.selIdx]) {
      this.app.copyText(this.skills[this.selIdx].name);
      return true;
    }
    return false;
  }
};

// vendor/dsh-neotui/src/views.js
var K2 = new Proxy({}, { get(_k, key) {
  return T[key];
} });
var require2 = (0, import_node_module.createRequire)((0, import_node_path7.join)(process.cwd(), "dsh-client.cjs"));
var TUI_VERSION = true ? "1.0.0" : "development";
var dshVersionCache = null;
function installedDshVersion(run = import_node_child_process4.spawnSync) {
  if (dshVersionCache) return dshVersionCache;
  if (process.env.DSH_VERSION) return dshVersionCache = process.env.DSH_VERSION.replace(/^v/, "");
  try {
    const file = require2.resolve("@deepseek-ai/dsh/package.json");
    const version = JSON.parse((0, import_node_fs7.readFileSync)(file, "utf8")).version;
    if (version) return dshVersionCache = version;
  } catch {
  }
  try {
    const result = run("dsh", ["--version"], { encoding: "utf8", timeout: 2e3 });
    const version = String(result.stdout ?? "").trim().replace(/^v/, "");
    if (result.status === 0 && version) return dshVersionCache = version;
  } catch {
  }
  return dshVersionCache = "unknown";
}
async function latestNpmVersion(name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5e3);
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body?.version !== "string" || !body.version) throw new Error("\u7F3A\u5C11\u7248\u672C\u53F7");
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}
function compareSemver(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? ""));
    if (!match) return null;
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    if (a.pre[i] === void 0 || b.pre[i] === void 0) return a.pre[i] === b.pre[i] ? 0 : a.pre[i] === void 0 ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const ai = /^\d+$/.test(a.pre[i]), bi = /^\d+$/.test(b.pre[i]);
    if (ai && bi) return Number(a.pre[i]) > Number(b.pre[i]) ? 1 : -1;
    if (ai !== bi) return ai ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}
function renderToolCard(view, width, expanded) {
  const card = view?.card ? view : view?.view ?? {};
  const lines = [];
  const title = truncate(card.title ?? card.name ?? "tool", width - 4);
  lines.push([
    { t: "\u25B8 ", fg: K2.ACCENT, bold: true },
    { t: title, fg: K2.TXT, bold: true }
  ]);
  const pushText = (label, text, fg) => {
    const segs = [{ t: label, fg: K2.DIM }];
    const content = String(text ?? "");
    for (const ln of content.split("\n")) {
      lines.push([...segs, { t: truncate(ln, width - 6 - strWidth(label)), fg: fg ?? K2.TXT }]);
      if (lines.length > 40) break;
    }
  };
  switch (card.card) {
    case "terminal": {
      const cmd = card.command ?? title;
      lines.push([{ t: `  ${card.cwd ? `${card.cwd} ` : ""}$ ${truncate(cmd, width - 8)}`, fg: K2.ACCENT, code: true }]);
      const output = String(card.output ?? "");
      const rows = output.split("\n");
      const cap = expanded ? 200 : 8;
      for (const row of rows.slice(0, cap)) lines.push([{ t: "  " + truncate(row, width - 4), fg: K2.TXT, code: true }]);
      if (rows.length > cap) lines.push([{ t: expanded ? `  \u2026\u5176\u4F59 ${rows.length - cap} \u884C\u8D85\u8FC7\u8BE6\u60C5\u4E0A\u9650` : `  \u2026\u9690\u85CF ${rows.length - cap} \u884C\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09`, fg: K2.FAINT }]);
      if (card.signal) lines.push([{ t: `  signal ${card.signal}`, fg: K2.WARN, bold: true }]);
      else if (card.exitCode != null) lines.push([{ t: `  exit ${card.exitCode}`, fg: card.exitCode === 0 ? K2.OK : K2.WARN, bold: card.exitCode !== 0 }]);
      else if (card.running) lines.push([{ t: "  \u25CF \u8FD0\u884C\u4E2D", fg: K2.WARN }]);
      break;
    }
    case "read": {
      if (card.label) lines.push([{ t: `  ${truncate(card.label, width - 4)}${card.lang ? ` \xB7 ${card.lang}` : ""}`, fg: K2.ACCENT, underline: true }]);
      const rows = card.lines ?? [];
      const cap = expanded ? 200 : 8;
      for (const row of rows.slice(0, cap)) lines.push([{ t: `${String(row.number ?? "").padStart(5)} \u2502 `, fg: K2.FAINT }, { t: truncate(row.text ?? "", width - 10), fg: K2.TXT, code: true }]);
      if (rows.length > cap) lines.push([{ t: `  \u2026\u9690\u85CF ${rows.length - cap} \u884C`, fg: K2.FAINT }]);
      if (card.totalLines != null) lines.push([{ t: `  \u663E\u793A ${rows.length}/${card.totalLines} \u884C`, fg: K2.DIM }]);
      break;
    }
    case "search": {
      if (card.kind === "paths") {
        for (const path of (card.paths ?? []).slice(0, expanded ? 200 : 8)) lines.push([{ t: "  \u2022 " + truncate(path, width - 6), fg: K2.TXT }]);
      } else if (card.kind === "matches") {
        for (const file of card.files ?? []) {
          lines.push([{ t: "  " + truncate(file.path ?? "", width - 4), fg: K2.ACCENT, underline: true }]);
          for (const match of (file.matches ?? []).slice(0, expanded ? 100 : 4)) lines.push([{ t: `   ${match.lineNumber ?? "?"}: `, fg: K2.FAINT }, { t: truncate(match.line ?? "", width - 10), fg: K2.TXT }]);
        }
      }
      lines.push([{ t: `  ${card.truncated ? `\u663E\u793A\u90E8\u5206\u7ED3\u679C / \u5171 ${card.total}` : `\u5171 ${card.total ?? 0} \u9879`}`, fg: card.truncated ? K2.WARN : K2.DIM }]);
      if (card.recovery) pushText("  \u6062\u590D: ", card.recovery, K2.ACCENT);
      break;
    }
    case "web": {
      if (card.kind === "fetch") {
        lines.push([{ t: `  ${card.statusCode ?? "?"} ${truncate(card.url ?? "", width - 10)}`, fg: (card.statusCode ?? 500) < 400 ? K2.OK : K2.ERR, link: card.url }]);
      } else {
        if (card.answer) pushText("  ", card.answer);
        for (const source of (card.sources ?? []).slice(0, expanded ? 30 : 6)) {
          lines.push([{ t: "  \u2197 ", fg: K2.ACCENT }, { t: truncate(source.title ?? source.url ?? "\u6765\u6E90", width - 6), fg: K2.LINK, link: source.url }]);
          if (source.snippet && expanded) lines.push([{ t: "    " + truncate(source.snippet, width - 6), fg: K2.DIM }]);
        }
      }
      if (card.truncated) lines.push([{ t: "  \u26A0 \u7ED3\u679C\u5DF2\u622A\u65AD", fg: K2.WARN }]);
      break;
    }
    case "diff": {
      for (const d of card.diffs ?? []) {
        lines.push([{ t: "  " + truncate(d.path ?? "", width - 6), fg: K2.ACCENT, underline: true }]);
        if (d.oldText == null) {
          lines.push([{ t: "  + \u65B0\u5EFA\u6587\u4EF6", fg: K2.OK }]);
        } else if (d.newText == null) {
          lines.push([{ t: "  - \u5220\u9664\u6587\u4EF6", fg: K2.ERR }]);
        }
        const oldLines = (d.oldText ?? "").split("\n");
        const newLines = (d.newText ?? "").split("\n");
        if (!expanded && oldLines.length + newLines.length > 6) {
          lines.push([{ t: `  \u2500 ${oldLines.length} \u884C\u6539\u52A8\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09`, fg: K2.FAINT }]);
        } else {
          const max = Math.max(oldLines.length, newLines.length);
          for (let i = 0; i < Math.min(max, expanded ? 200 : 6); i++) {
            const o = oldLines[i], n = newLines[i];
            if (o === n) {
              lines.push([{ t: "   ", fg: K2.FAINT }, { t: truncate(o ?? "", width - 8), fg: K2.DIM }]);
            } else {
              if (o !== void 0) lines.push([{ t: " - ", fg: K2.ERR }, { t: truncate(o, width - 8), fg: T.PINK }]);
              if (n !== void 0) lines.push([{ t: " + ", fg: K2.OK }, { t: truncate(n, width - 8), fg: T.GREENG }]);
            }
            if (lines.length > 60) break;
          }
        }
      }
      break;
    }
    default: {
      for (const block of card.content ?? []) {
        if (block?.type === "text" && block.text) pushText("  ", block.text);
      }
      for (const key of ["output", "text", "stdout", "stderr", "result", "detail", "message", "summary"]) {
        if (card[key] !== void 0) {
          pushText(`  ${key}: `, card[key]);
          break;
        }
      }
      for (const sec of card.sections ?? []) {
        if (sec?.label) lines.push([{ t: `  ${sec.label}`, fg: K2.ACCENT, bold: true }]);
        for (const row of sec?.rows ?? sec?.items ?? []) {
          const r = typeof row === "string" ? row : row?.text ?? row?.label ?? JSON.stringify(row);
          lines.push([{ t: "   " + truncate(r, width - 7), fg: K2.TXT }]);
        }
      }
      if (card.exitCode !== void 0 && card.exitCode !== 0) {
        lines.push([{ t: `  exit: ${card.exitCode}`, fg: K2.ERR }]);
      }
      break;
    }
  }
  return lines;
}
function jsonPreview(args, width, expanded) {
  let s;
  try {
    s = JSON.stringify(JSON.parse(args ?? "{}"), null, 1);
  } catch {
    s = String(args ?? "");
  }
  return s.split("\n").slice(0, expanded ? 30 : 4).map((l) => [{ t: "  " + truncate(l, width - 4), fg: K2.DIM, code: true }]);
}
function applyEvent(nodes, event, view, log2, state = null) {
  const st = state ?? { step: null };
  const cur = () => nodes[nodes.length - 1];
  const d = event.data ?? {};
  switch (event.type) {
    case "step/start": {
      st.step = d.step ?? (st.step ?? 0) + 1;
      break;
    }
    case "user/message": {
      const message = d.message ?? d;
      const content = d.content ?? message.content;
      const text = partsToText(content);
      const images = partsToImages(content);
      const id = d.id ?? message.id ?? null;
      const source = d.source ?? message.source ?? { kind: "user" };
      const direct = source?.kind === "user";
      const turnStartAt = direct ? st.turnStart ?? event.time ?? Date.now() : null;
      const kind = direct ? "user" : source?.kind === "goal" ? "goal-round" : source?.kind === "subagent-report" || source?.kind === "subagent-settled" ? "subagent-receipt" : "context";
      if (text !== null || images) nodes.push({ kind, text: text ?? "", images, id, source, step: st.step, turnStartAt });
      break;
    }
    case "assistant/message": {
      const parts = d.message?.content ?? [];
      const blocks = [];
      for (const p of parts) {
        if (p.type === "text") blocks.push({ kind: "text", text: p.text ?? "" });
        else if (p.type === "reasoning") blocks.push({ kind: "reasoning", text: p.text ?? "" });
        else if (p.type === "tool-call") {
        } else blocks.push({ kind: "other", text: JSON.stringify(p).slice(0, 500) });
      }
      const last = cur();
      const prevBlocks = last && last.kind === "assistant" ? last.blocks ?? [] : [];
      for (const b of blocks) b.endedAt = event.time ?? Date.now();
      for (let bi = 0; bi < blocks.length; bi++) {
        if (blocks[bi].startedAt === void 0 && prevBlocks[bi]?.startedAt !== void 0) blocks[bi].startedAt = prevBlocks[bi].startedAt;
      }
      const images = partsToImages(d.message?.content);
      const id = d.message?.id ?? null;
      if (last && last.kind === "assistant" && last.streaming !== false) {
        last.blocks = blocks;
        last.images = images ?? last.images;
        last.id = id ?? last.id;
        last.streaming = false;
      } else {
        nodes.push({ kind: "assistant", blocks, images, id, streaming: false, step: st.step });
      }
      break;
    }
    case "assistant/chunk": {
      const ch = d.chunk ?? {};
      let node = cur();
      if (!node || node.kind !== "assistant" || node.finalized) {
        node = { kind: "assistant", blocks: [], streaming: true, finalized: false, step: st.step, turnStartAt: st.turnStart ?? void 0 };
        nodes.push(node);
      }
      node.streaming = true;
      if (ch.type === "block-start") {
        const kind = ch.blockType === "tool-call" ? "tool" : ch.blockType ?? "text";
        node.blocks[ch.index ?? 0] = { kind, text: "", args: kind === "tool" ? "" : void 0, streaming: true, startedAt: event.time ?? Date.now() };
      } else if (ch.type === "text-delta") {
        const b = node.blocks[ch.index ?? 0];
        if (b) b.text = (b.text ?? "") + (ch.delta ?? "");
      } else if (ch.type === "reasoning-delta") {
        const b = node.blocks[ch.index ?? 0];
        if (b) b.text = (b.text ?? "") + (ch.text ?? "");
      } else if (ch.type === "tool-call-delta") {
        const b = node.blocks[ch.index ?? 0];
        if (b) {
          if (ch.name !== void 0) b.name = ch.name;
          if (ch.id !== void 0) b.callId = ch.id;
          if (ch.argumentsDelta !== void 0) b.args = (b.args ?? "") + ch.argumentsDelta;
        }
      } else if (ch.type === "block-end") {
        const b = node.blocks[ch.index ?? 0];
        if (b) {
          b.streaming = false;
          b.endedAt = event.time ?? b.endedAt;
        }
      }
      break;
    }
    case "tool/call": {
      const callId = d.callId;
      let block = null;
      for (const nd of nodes) {
        if (nd.kind !== "assistant") continue;
        block = nd.blocks.find((b) => b.kind === "tool" && b.callId === callId);
        if (block) break;
      }
      if (block) {
        if (d.name !== void 0) block.name = d.name;
        if (d.arguments !== void 0) block.args = d.arguments;
        if (view?.view !== void 0) block.view = view.view;
        block.result = null;
        if (block.startedAt === void 0) block.startedAt = event.time ?? Date.now();
        break;
      }
      let node = cur();
      if (!node || node.kind !== "assistant") {
        node = { kind: "assistant", blocks: [], streaming: true, finalized: false, step: st.step, turnStartAt: st.turnStart ?? void 0 };
        nodes.push(node);
      }
      node.blocks.push({ kind: "tool", name: d.name, args: d.arguments, callId, view: view?.view, result: null, subCalls: [], startedAt: event.time ?? Date.now() });
      break;
    }
    case "tool/code-dispatch-start": {
      addDispatch(nodes, d, event, false);
      break;
    }
    case "tool/code-dispatch": {
      addDispatch(nodes, d, event, true);
      break;
    }
    case "tool/result": {
      const callId = d.message?.source?.callId;
      const text = partsToText(d.message?.content);
      const node = nodes.findLast((nd) => nd.kind === "assistant" && nd.blocks.some((b) => b.kind === "tool" && b.callId === callId));
      let block = node?.blocks.find((b) => b.kind === "tool" && b.callId === callId);
      if (!block) {
        outer:
          for (let ni = nodes.length - 1; ni >= 0; ni--) {
            const nd = nodes[ni];
            if (nd.kind !== "assistant") continue;
            for (const b of nd.blocks ?? []) {
              if (b.kind === "tool" && b.result == null) {
                block = b;
                break outer;
              }
            }
          }
      }
      if (block) {
        block.result = text ?? JSON.stringify(d).slice(0, 400);
        if (view?.view !== void 0) block.resultView = view.view;
        block.isError = d.message?.content?.some?.((p) => p?.isError === true) || !!d.error;
        block.error = d.error;
        block.endedAt = event.time ?? Date.now();
      }
      break;
    }
    case "turn/start": {
      st.turnStart = event.time ?? Date.now();
      st.turn = d.turn ?? st.turn;
      const stale = [...nodes].reverse().find((n) => n.kind === "turn-progress" && n.streaming);
      if (stale) {
        stale.streaming = false;
        stale.endedAt = st.turnStart;
        stale.incomplete = true;
      }
      nodes.push({ kind: "turn-progress", turn: d.turn, startedAt: st.turnStart, streaming: true });
      break;
    }
    case "turn/end": {
      const end = event.time ?? Date.now();
      const turn = d.turn ?? st.turn;
      let progress = [...nodes].reverse().find((n) => n.kind === "turn-progress" && n.turn === turn && n.streaming);
      if (!progress) progress = [...nodes].reverse().find((n) => n.kind === "turn-progress" && n.streaming);
      if (progress) {
        progress.streaming = false;
        progress.endedAt = end;
        progress.reason = d.reason;
      }
      const node = [...nodes].reverse().find((n) => n.kind === "assistant");
      if (node && st.turnStart !== void 0) node.turnMs = Math.max(0, end - st.turnStart);
      const reason = d.reason?.kind;
      if (reason === "error") nodes.push({ kind: "turn-error", text: d.reason?.error?.message ?? "\u6A21\u578B\u8BF7\u6C42\u5931\u8D25", code: d.reason?.error?.code });
      else if (reason === "max-tokens") nodes.push({ kind: "turn-max-tokens", text: "\u5DF2\u8FBE\u5230\u672C\u8F6E\u6700\u5927\u8F93\u51FA token \u9650\u5236" });
      else if (["cancelled", "interrupted", "aborted"].includes(reason)) {
        for (const assistant of nodes) for (const block of assistant.kind === "assistant" ? assistant.blocks ?? [] : []) if (block.kind === "tool" && block.result == null) block.stopped = true;
        nodes.push({ kind: "system", text: "\u25A0 \u672C\u8F6E\u5DF2\u505C\u6B62" });
      } else if (reason === "blocked") nodes.push({ kind: "system", text: "\u26A0 \u672C\u8F6E\u5DF2\u963B\u585E" });
      st.turnStart = null;
      break;
    }
    case "llm/retry": {
      nodes.push({ kind: "retry", turn: d.turn, attempt: d.attempt, status: "scheduled", text: d.failure?.message ?? d.error?.message ?? "\u6A21\u578B\u8BF7\u6C42\u5931\u8D25", delayMs: d.delayMs });
      break;
    }
    case "llm/retry-started": {
      const retry = [...nodes].reverse().find((n) => n.kind === "retry" && (d.turn == null || n.turn === d.turn));
      if (retry) retry.status = "started";
      else nodes.push({ kind: "retry", turn: d.turn, attempt: d.attempt, status: "started", text: "\u6A21\u578B\u8BF7\u6C42\u6B63\u5728\u91CD\u8BD5" });
      break;
    }
    case "step/end": {
      const node = cur();
      if (node && node.kind === "assistant") {
        node.streaming = false;
        node.finalized = true;
        for (const b of node.blocks ?? []) {
          b.streaming = false;
          if (b.endedAt === void 0) b.endedAt = event.time ?? Date.now();
        }
      }
      break;
    }
    case "session/title": {
      nodes.push({ kind: "title", text: d.title ?? "" });
      break;
    }
    case "compaction": {
      nodes.push({ kind: "system", text: "\u27F3 " + (d.message ?? d.reason ?? "\u4E0A\u4E0B\u6587\u538B\u7F29") });
      break;
    }
    case "command/run": {
      nodes.push({ kind: "command", commandId: d.commandId, text: `/${d.name}${d.args ?? ""}`, status: "running" });
      break;
    }
    case "command/done": {
      const command = [...nodes].reverse().find((n) => n.kind === "command" && n.commandId === d.commandId);
      if (command) {
        command.status = d.kind;
        command.detail = d.text;
      } else nodes.push({ kind: "command", commandId: d.commandId, text: "\u547D\u4EE4", status: d.kind, detail: d.text });
      break;
    }
    case "agent/inbox/spliced": {
      for (const message of d.inserted ?? []) {
        if (message.source?.kind !== "user") continue;
        const text = partsToText(message.content);
        if (text != null && d.target === "next-step") nodes.push({ kind: "steering", text, id: message.id, source: message.source });
      }
      break;
    }
    default: {
      const KNOWN = /* @__PURE__ */ new Set([
        "todo/write",
        "goal/change",
        "plan/mode",
        "request/header",
        "request/context",
        "permission/preset",
        "sandbox/mode",
        "approval/policy",
        "session/title-llm-request",
        "session/end-seed"
      ]);
      if (!KNOWN.has(event.type) && !SEEN_TYPES.has(event.type)) {
        SEEN_TYPES.add(event.type);
        log2(`[chat] unknown event type: ${event.type}`);
      }
    }
  }
}
function nodeForEvents(events, log2) {
  const nodes = [];
  const state = { step: null };
  for (const { event, view } of events) {
    const before = nodes.length;
    applyEvent(nodes, event, view, log2, state);
    const seq = event?.seq;
    if (Number.isFinite(seq)) {
      if (nodes.length > before) {
        for (let i = before; i < nodes.length; i++) {
          if (nodes[i].firstSeq == null) nodes[i].firstSeq = seq;
          nodes[i].lastSeq = seq;
        }
      }
    }
  }
  return nodes;
}
var SEEN_TYPES = /* @__PURE__ */ new Set();
function partsToImages(content) {
  if (!Array.isArray(content)) return null;
  const refs = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "image" && p.attachment && typeof p.attachment === "object") refs.push(p.attachment);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return refs.length ? refs : null;
}
function partsToText(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const texts = [];
  const walk = (arr) => {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (Array.isArray(p.content)) walk(p.content);
    }
  };
  walk(content);
  return texts.length ? texts.join("\n") : null;
}
var DISPATCH_MAX_DEPTH = 16;
var DISPATCH_MAX_NODES = 128;
var DISPATCH_RESULT_MAX = 4e3;
var DISPATCH_RENDER_LINES = 400;
function findToolBlock(nodes, callId) {
  for (let ni = nodes.length - 1; ni >= 0; ni--) {
    const nd = nodes[ni];
    if (nd.kind !== "assistant") continue;
    for (let bi = (nd.blocks ?? []).length - 1; bi >= 0; bi--) {
      const b = nd.blocks[bi];
      if (b.kind === "tool" && b.callId === callId) return b;
    }
  }
  return null;
}
function countDispatch(block) {
  let n = 0;
  const stack = [...block.subCalls ?? []];
  while (stack.length) {
    const c = stack.pop();
    n++;
    if (c.subCalls?.length) stack.push(...c.subCalls);
  }
  return n;
}
function forEachDispatch(node, fn) {
  for (const b of node.blocks ?? []) {
    if (b.kind !== "tool") continue;
    const stack = [...b.subCalls ?? []];
    while (stack.length) {
      const c = stack.pop();
      fn(c, b);
      if (c.subCalls?.length) stack.push(...c.subCalls);
    }
  }
}
function findDispatchInTree(block, callId) {
  const stack = [{ children: block.subCalls ?? [], depth: 0 }];
  while (stack.length) {
    const frame = stack.pop();
    for (let i = 0; i < frame.children.length; i++) {
      const child = frame.children[i];
      const depth = frame.depth + 1;
      if (child.callId === callId) return { child, container: frame.children, index: i, depth };
      if (child.subCalls?.length) stack.push({ children: child.subCalls, depth });
    }
  }
  return null;
}
function findDispatchParent(block, parentCallId) {
  if (block.callId === parentCallId) return { node: block, depth: 0, ancestors: [] };
  const stack = [{ node: block, children: block.subCalls ?? [], depth: 0, ancestors: [] }];
  while (stack.length) {
    const frame = stack.pop();
    for (let i = 0; i < frame.children.length; i++) {
      const child = frame.children[i];
      const depth = frame.depth + 1;
      const ancestors = [...frame.ancestors, frame.node.callId];
      if (child.callId === parentCallId) return { node: child, depth, ancestors };
      if (child.subCalls?.length) stack.push({ node: child, children: child.subCalls, depth, ancestors });
    }
  }
  return null;
}
function locateDispatchRoot(nodes, rootCallId) {
  if (rootCallId != null) {
    const exact = findToolBlock(nodes, rootCallId);
    if (exact) return exact;
  }
  const scan = (wantPending) => {
    for (let ni = nodes.length - 1; ni >= 0; ni--) {
      const nd = nodes[ni];
      if (nd.kind !== "assistant") continue;
      for (let bi = (nd.blocks ?? []).length - 1; bi >= 0; bi--) {
        const b = nd.blocks[bi];
        if (b.kind === "tool" && (!wantPending || b.result == null)) return b;
      }
    }
    return null;
  };
  return scan(true) ?? scan(false);
}
function dispatchArgs(d) {
  if (d.arguments === void 0 || d.arguments === null) return "";
  return typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments);
}
function settleDispatch(node, d, event) {
  if (d.name !== void 0) node.name = d.name;
  if (d.arguments !== void 0) node.args = dispatchArgs(d);
  node.content = d.content ?? null;
  node.isError = d.isError === true || !!d.error;
  node.error = d.error ?? null;
  const text = partsToText(d.content);
  node.result = text != null ? String(text).slice(0, DISPATCH_RESULT_MAX) : node.isError ? String(d.error?.message ?? "\u9519\u8BEF").slice(0, DISPATCH_RESULT_MAX) : "";
  node.endedAt = event.time ?? node.endedAt ?? Date.now();
}
function addDispatch(nodes, d, event, settle) {
  const subCallId = typeof d.subCallId === "string" && d.subCallId !== "" ? d.subCallId : null;
  if (subCallId == null) return;
  const block = locateDispatchRoot(nodes, typeof d.rootCallId === "string" && d.rootCallId !== "" ? d.rootCallId : null);
  if (!block) return;
  if (!Array.isArray(block.subCalls)) block.subCalls = [];
  const existing = findDispatchInTree(block, subCallId)?.child;
  if (existing) {
    if (settle) settleDispatch(existing, d, event);
    return;
  }
  const parent = findDispatchParent(block, typeof d.parentCallId === "string" && d.parentCallId !== "" ? d.parentCallId : block.callId);
  const parentNode = parent ? parent.node : block;
  const depth = parent ? parent.depth + 1 : 1;
  if (depth > DISPATCH_MAX_DEPTH) return;
  if (subCallId === parentNode.callId) return;
  if (parent?.ancestors?.includes(subCallId)) return;
  if (countDispatch(block) >= DISPATCH_MAX_NODES) return;
  if (findDispatchInTree(block, subCallId)) return;
  const node = {
    kind: "dispatch",
    callId: subCallId,
    name: d.name,
    args: dispatchArgs(d),
    result: null,
    content: null,
    isError: false,
    error: null,
    startedAt: event.time ?? Date.now(),
    endedAt: null,
    subCalls: []
  };
  if (!Array.isArray(parentNode.subCalls)) parentNode.subCalls = [];
  parentNode.subCalls.push(node);
  if (settle) settleDispatch(node, d, event);
}
var IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
var MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
function clipboardImageFromWayland(run = import_node_child_process4.spawnSync, platform = process.platform) {
  const b = copyImageFromClipboard({ platform, runSync: run });
  if (!b?.length) return null;
  const actual = detectImageType(b);
  const ext = actual === "image/jpeg" ? "jpg" : actual.slice("image/".length);
  return { mediaType: actual, data: b.toString("base64"), name: `clipboard-${Date.now()}.${ext}`, bytes: b.length };
}
function buildPromptParts(text, { readFile = null } = {}) {
  const parts = [];
  const images = [];
  const errors = [];
  const re = /@([^\s@]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    const ext = IMAGE_EXT.exec(path);
    if (!ext) continue;
    const mediaType = MEDIA_TYPES[ext[1].toLowerCase()];
    if (!mediaType) continue;
    try {
      const data = readFile(path);
      if (data === null) throw new Error("\u6587\u4EF6\u4E0D\u5B58\u5728");
      parts.push({ type: "text", text: text.slice(last, m.index) });
      parts.push({ type: "image", mediaType, data, name: path.split("/").pop() });
      images.push(path);
      last = m.index + m[0].length;
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
  }
  parts.push({ type: "text", text: text.slice(last) });
  return { parts, images, errors };
}
var SidebarTree = class extends Widget {
  constructor(app) {
    super({ x: 0, y: 0, w: 30, h: app.screen.h - 1 });
    this.app = app;
    this.groups = [];
    this.rows = [];
    this.scrollY = 0;
    this.sel = 0;
    this.focused = false;
    this.collapsed = /* @__PURE__ */ new Set();
  }
  setData(workspaces, sessions, archivedIds, currentSessionId) {
    const archived = new Set(archivedIds ?? []);
    const visible = (s) => s.origin !== "subagent" && (!s.blank || s.sessionId === currentSessionId);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const groups = [];
    const accounted = /* @__PURE__ */ new Set();
    for (const ws of workspaces) {
      const members = [];
      for (const id of ws.sessionIds ?? []) {
        const s = byId.get(id);
        if (s === void 0 || archived.has(id) || !visible(s)) continue;
        accounted.add(id);
        members.push(s);
      }
      groups.push({
        kind: "group",
        key: `ws:${ws.workspaceId}`,
        title: ws.title,
        path: ws.path,
        workspaceId: ws.workspaceId,
        sessions: members
      });
    }
    const stray = sessions.filter((s) => !accounted.has(s.sessionId) && !archived.has(s.sessionId) && visible(s));
    if (stray.length > 0) {
      groups.push({ kind: "group", key: "ws:", title: "\u672A\u5206\u7EC4", path: null, workspaceId: null, sessions: stray });
    }
    this.groups = groups;
    this.#flatten();
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
    this.#scrollToSel();
    this.app.redraw();
  }
  #flatten() {
    const rows = [];
    for (const g of this.groups) {
      rows.push({ kind: "group", group: g });
      if (!this.collapsed.has(g.key)) {
        for (const sess of g.sessions) rows.push({ kind: "session", group: g, session: sess });
      }
    }
    this.rows = rows;
  }
  toggle(group) {
    if (this.collapsed.has(group.key)) this.collapsed.delete(group.key);
    else this.collapsed.add(group.key);
    this.#flatten();
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
    this.#scrollToSel();
  }
  collapseAll() {
    for (const g of this.groups) this.collapsed.add(g.key);
    this.#flatten();
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
    this.#scrollToSel();
  }
  expandAll() {
    this.collapsed.clear();
    this.#flatten();
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll()));
    this.#scrollToSel();
  }
  #rowTitle(sess) {
    return sess.projections?.values?.title ?? (sess.blank ? "\uFF08\u7A7A\u767D\u4F1A\u8BDD\uFF09" : sess.sessionId.slice(0, 8));
  }
  render(screen) {
    screen.fillRect(this.x, this.y, this.x + this.w - 1, this.y + this.h - 1, " ", {});
    const w = this.w - 1;
    screen.text(this.x, this.y, truncate("\u25A3 \u5DE5\u4F5C\u533A", w - 2), { fg: this.focused ? T.SELFG : T.ACCENT, bg: this.focused ? T.ACCENT : -1, attrs: 1 });
    screen.hline(this.x, this.x + w, this.y + 1, "\u2500", { fg: T.BORDER });
    const listTop = this.y + 2;
    for (let i = 0; i < this.h - 2; i++) {
      const idx = this.scrollY + i;
      const row = this.rows[idx];
      const y = listTop + i;
      if (!row) {
        screen.hline(this.x, this.x + w, y, " ", {});
        continue;
      }
      const sel = idx === this.sel;
      if (row.kind === "group") {
        const g = row.group;
        const open = !this.collapsed.has(g.key);
        const hasRun = g.sessions.some((s) => s.running);
        screen.text(
          this.x,
          y,
          truncate(`${open ? "\u25BE" : "\u25B8"} ${g.title} (${g.sessions.length})`, w - 2),
          { fg: sel && this.focused ? K2.BOLD : K2.DIM, bg: sel && this.focused ? K2.MENUSEL : -1, attrs: sel && this.focused ? 1 : 0 }
        );
        if (hasRun) screen.text(this.x + w - 1, y, "\u25CF", { fg: K2.OK, bg: sel && this.focused ? K2.MENUSEL : -1 });
      } else {
        const s = row.session;
        const indent = "  ";
        const badge = s.running ? "\u25CF" : s.blank ? "\u25CB" : " ";
        const title = truncate(this.#rowTitle(s), w - 4);
        const segs = [
          { t: indent + badge + " ", fg: s.running ? K2.OK : K2.FAINT, bg: sel && this.focused ? K2.MENUSEL : -1 },
          { t: title, fg: sel && this.focused ? K2.BOLD : K2.TXT, bg: sel && this.focused ? K2.MENUSEL : -1, attrs: sel && this.focused ? 1 : 0 }
        ];
        let px = this.x;
        for (const seg of segs) {
          const tx = truncate(seg.t, this.x + w - px);
          screen.text(px, y, tx, {
            fg: seg.fg,
            bg: seg.bg ?? -1,
            attrs: seg.attrs ?? 0
          });
          px += strWidth(tx);
        }
      }
    }
    const listH = this.h - 2;
    if (this.rows.length > listH) {
      const total = Math.max(1, this.rows.length);
      const thumbH = Math.max(1, Math.floor(listH * listH / total));
      const thumbY = Math.floor((listH - 2) * this.scrollY / Math.max(1, this.rows.length - listH));
      for (let i = 0; i < listH; i++) {
        const inThumb = i >= 1 + thumbY && i < 1 + thumbY + thumbH;
        const inTrack = i >= 1 && i < listH - 1;
        screen.put(this.x + this.w - 1, this.y + 2 + i, inThumb ? "\u2588" : inTrack ? "\u2591" : " ", { fg: inThumb ? K2.SCROLLTHUMB : K2.SCROLLTRACK });
      }
    }
  }
  maxScroll() {
    return Math.max(0, this.rows.length - (this.h - 2));
  }
  scroll(dy) {
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy));
  }
  #scrollToSel() {
    if (this.sel < this.scrollY) this.scrollY = this.sel;
    else if (this.sel >= this.scrollY + this.h - 2) this.scrollY = this.sel - (this.h - 2) + 1;
  }
  move(delta) {
    if (this.rows.length === 0) return false;
    const next = wrapIndex(this.sel + delta, this.rows.length);
    this.sel = next;
    this.#scrollToSel();
    return true;
  }
  currentRow() {
    return this.rows[this.sel] ?? null;
  }
  #menuFor(row) {
    if (!row) return [
      { label: "\u65B0\u5EFA\u5DE5\u4F5C\u533A\u2026", action: () => this.app.addWorkspace() },
      { label: "\u65B0\u5EFA\u4F1A\u8BDD", action: () => this.app.newSessionIn(null) }
    ];
    if (row.kind === "session") return null;
    const items = [
      { label: "\u65B0\u5EFA\u4F1A\u8BDD", action: () => this.app.newSessionIn(row.group) },
      { label: "\u65B0\u5EFA\u5DE5\u4F5C\u533A\u2026", action: () => this.app.addWorkspace() },
      { label: "\u6298\u53E0\u5168\u90E8", action: () => {
        this.collapseAll();
        this.app.redraw();
      } },
      { label: "\u5C55\u5F00\u5168\u90E8", action: () => {
        this.expandAll();
        this.app.redraw();
      } }
    ];
    if (row.group.workspaceId) {
      items.push({ label: "\u91CD\u547D\u540D\u5DE5\u4F5C\u533A", action: () => this.app.renameWorkspace(row.group) });
      items.push({ label: "\u5220\u9664\u5DE5\u4F5C\u533A\u2026", action: () => this.app.deleteWorkspace(row.group) });
    }
    return items;
  }
  openCurrentMenu() {
    const row = this.currentRow();
    const ev = { x: this.x + 2, y: this.y + 2 + Math.max(0, this.sel - this.scrollY) };
    if (row?.kind === "session") this.app.sessionMenu({ data: row.session }, ev);
    else this.app.openMenu(this.#menuFor(row), ev);
    return true;
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up") {
      this.scroll(-3);
      return true;
    }
    if (ev.kind === "wheel-down") {
      this.scroll(3);
      return true;
    }
    if (ev.kind === "press" && ev.button === 0) {
      const idx = this.scrollY + (ev.y - this.y - 2);
      const row = this.rows[idx];
      if (!row) return false;
      this.sel = idx;
      if (row.kind === "group") {
        this.toggle(row.group);
        this.app.redraw();
      } else {
        this.app.openSession(row.session.sessionId);
      }
      return true;
    }
    if (ev.kind === "press" && ev.button === 2) {
      const idx = this.scrollY + (ev.y - this.y - 2);
      const row = this.rows[idx];
      if (!row) {
        this.app.openMenu(this.#menuFor(null), ev);
        return true;
      }
      this.sel = idx;
      if (row.kind === "session") this.app.sessionMenu({ data: row.session }, ev);
      else this.app.openMenu(this.#menuFor(row), ev);
      return true;
    }
    return false;
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    switch (ev.name) {
      case "up":
        return this.move(-1);
      case "down":
        return this.move(1);
      case "pgup":
        this.scroll(-this.h);
        return true;
      case "pgdn":
        this.scroll(this.h);
        return true;
      case "home":
        this.sel = 0;
        this.#scrollToSel();
        return true;
      case "end":
        this.sel = Math.max(0, this.rows.length - 1);
        this.#scrollToSel();
        return true;
      case "enter": {
        const row = this.currentRow();
        if (!row) return false;
        if (row.kind === "group") {
          this.toggle(row.group);
          this.app.redraw();
        } else this.app.openSession(row.session.sessionId);
        return true;
      }
      case "left": {
        if (ev.ctrl) return false;
        const row = this.currentRow();
        if (row?.kind === "group" && !this.collapsed.has(row.group.key)) {
          this.toggle(row.group);
          this.app.redraw();
          return true;
        }
        if (row?.kind === "session") {
          this.sel = this.rows.findLastIndex((r, i) => i <= this.sel && r.kind === "group");
          this.#scrollToSel();
          return true;
        }
        return false;
      }
      case "right": {
        if (ev.ctrl) return false;
        const row = this.currentRow();
        if (row?.kind === "group" && this.collapsed.has(row.group.key)) {
          this.toggle(row.group);
          this.app.redraw();
          return true;
        }
        if (row?.kind === "group") {
          this.sel = Math.min(this.rows.length - 1, this.sel + 1);
          this.#scrollToSel();
          return true;
        }
        return false;
      }
      case "char":
        if (ev.ctrl && ev.key === "r") return this.openCurrentMenu();
        if (ev.ctrl) return false;
        {
          const sbHit = bindingMatchFor(ev, keyBindings(), false, SIDEBAR_BINDING_ORDER);
          if (sbHit?.id === "insert") {
            this.app.focus(this.app.chat.input);
            this.app.redraw();
            return true;
          }
          if (sbHit?.id === "newSession") {
            const r = this.currentRow();
            if (r?.kind === "group") this.app.newSessionIn(r.group);
            else this.app.newSession();
            return true;
          }
        }
        if (ev.key === " ") {
          const row = this.currentRow();
          if (row?.kind === "group") {
            this.toggle(row.group);
            this.app.redraw();
            return true;
          }
          if (row?.kind === "session") {
            const groupIndex = this.rows.findLastIndex((candidate, index) => index <= this.sel && candidate.kind === "group");
            this.toggle(row.group);
            this.sel = Math.max(0, groupIndex);
            this.#scrollToSel();
            this.app.redraw();
            return true;
          }
          return false;
        }
        if (!ev.ctrl && (ev.key === "[" || ev.key === "]")) {
          const r = this.currentRow();
          if (r?.kind === "session") {
            this.app.moveSession(r.session, ev.key === "[" ? -1 : 1);
            return true;
          }
          return false;
        }
        return false;
    }
    return false;
  }
};
var SLASH_COMMANDS = [
  { name: "/reload", desc: "\u91CD\u65B0\u8F7D\u5165\u754C\u9762\uFF08\u4E0D\u91CD\u542F\u8FDB\u7A0B\uFF09" },
  { name: "/restart", desc: "\u91CD\u542F TUI \u52A0\u8F7D\u65B0\u7248\u672C" },
  { name: "/model", desc: "\u5207\u6362\u6A21\u578B" },
  { name: "/theme", desc: "\u5207\u6362\u914D\u8272\u4E3B\u9898" },
  { name: "/permission", desc: "\u4FEE\u6539\u6743\u9650\u6A21\u5F0F" },
  { name: "/goal", desc: "\u67E5\u770B\u5F53\u524D\u76EE\u6807" },
  { name: "/compact", desc: "\u538B\u7F29\u8F83\u65E9\u5BF9\u8BDD\u5386\u53F2" },
  { name: "/export", desc: "\u5BFC\u51FA\u5F53\u524D\u4F1A\u8BDD\u65E5\u5FD7" },
  { name: "/feedback", desc: "\u63D0\u4EA4\u4F1A\u8BDD\u53CD\u9988" },
  { name: "/plan", desc: "\u8FDB\u5165\u6216\u9000\u51FA\u8BA1\u5212\u6A21\u5F0F" }
];
var ChatView = class extends Widget {
  constructor(opts) {
    super(opts);
    this.app = opts.app;
    this.sessionId = null;
    this.title = "";
    this.nodes = [];
    this.lines = [];
    this.expanded = /* @__PURE__ */ new Set();
    this.collapsedBlocks = /* @__PURE__ */ new Set();
    const fd = foldDefaults();
    this.thinkMode = fd.think ? "expanded" : "collapsed";
    this.bashMode = fd.bash ? "expanded" : "collapsed";
    this.todosVisible = fd.todos;
    this.running = false;
    this.hasMore = false;
    this.loadingOlder = false;
    this.minSeq = null;
    this.earliestTime = null;
    this.view = new ScrollView({
      x: this.x,
      y: this.y,
      w: this.w,
      h: this.h - 2,
      autoScroll: true,
      title: "",
      onClick: (y, ev) => this.#clickLine(y, ev)
    });
    this.input = new Input({
      x: this.x,
      y: this.y + this.h - 2,
      w: this.w,
      h: 1,
      multi: true,
      maxLines: 6,
      app: this.app,
      commands: SLASH_COMMANDS,
      bg: T.PANEL,
      placeholder: "\u8F93\u5165\u6D88\u606F\u2026\uFF08Shift+Enter/Ctrl+J \u6362\u884C\uFF0CCtrl+L \u5C55\u5F00\uFF0C\u2191/\u2193 \u5386\u53F2\uFF0CTab \u8865\u5168 / \u547D\u4EE4\uFF0CEnter \u53D1\u9001\uFF09",
      onEnter: (v) => this.send(v),
      onChange: () => this.inputChanged()
    });
    this.contextNode = null;
    this.rebuildQueued = false;
    this.cache = /* @__PURE__ */ new Map();
    this.cardRanges = [];
    this.welcomeModes = [];
    this.welcomeModeIds = ["standard", "code", "minimal", "cordis"];
    this.welcomeModeSel = 0;
    this.pressY = null;
    this.pressInfo = null;
    this.pressCtx = null;
    this.pressX = null;
    this.selStart = null;
    this.selEnd = null;
    this.selAnchor = null;
    this.selFocus = null;
    this.blockItems = [];
    this.blockSel = -1;
    this.cursorMode = "block";
    this.cursor = { line: 0, col: 0 };
    this.visualAnchor = null;
    this.bindingPending = null;
    this.clipboardImages = [];
    this.attachments = [];
    this.stepState = { step: null };
  }
  /** Find the human-readable command/arguments paired to a pending approval. */
  toolCommandForCall(callId) {
    if (!callId) return null;
    for (let ni = this.nodes.length - 1; ni >= 0; ni--) {
      const block = this.nodes[ni]?.blocks?.find((b) => b.kind === "tool" && b.callId === callId);
      if (!block) continue;
      try {
        const args = JSON.parse(block.args ?? "{}");
        if (typeof args.command === "string") return args.command;
        return JSON.stringify(args, null, 2);
      } catch {
        return block.args ?? null;
      }
    }
    return null;
  }
  /** Queue a rebuild; flushed on the next frame render (throttles streaming). */
  /** Merge freshly arrived events (mux frames) into the tail INCREMENTALLY —
   *  each event mutates this.nodes directly via the same applyEvent the
   *  full-window re-derivation uses, so a lone reasoning-delta appends to the
   *  existing block instead of wiping it (the old "shows then deleted" bug). */
  mergeEvents(entries) {
    const beforeDiving = this.divingHeight();
    for (const { event, view } of entries) {
      applyEvent(this.nodes, event, view, this.app.log, this.stepState);
    }
    this.running = this.nodes.some((n) => (n.kind === "assistant" || n.kind === "turn-progress") && n.streaming);
    if (beforeDiving !== this.divingHeight()) this.inputChanged();
    this.queueRebuild();
  }
  /** Poll the tail of the open session (mux live path is unreliable). */
  async pollTail() {
    if (!this.sessionId || this.polling) return;
    const sessionId = this.sessionId;
    const epoch = this.app.sessionEpoch;
    this.polling = true;
    try {
      const hist = await this.app.api.call("session.history", { sessionId, maxMessages: 1 });
      if (this.sessionId !== sessionId || this.app.sessionEpoch !== epoch) {
        this.polling = false;
        return;
      }
      const events = hist.events ?? [];
      const fresh = events.filter((e) => e.event.seq > (this.lastSeq ?? -1));
      if (fresh.length === 0) {
        this.polling = false;
        return;
      }
      this.lastSeq = fresh[fresh.length - 1].event.seq;
      if (fresh.length > 4e3) this.pollSlow = true;
      this.syncTail(events);
    } catch {
    }
    this.polling = false;
  }
  /** Idempotently re-derive the tail node(s) from the complete last message.
   *  Dedup by message id so already-loaded nodes are updated, never duplicated. */
  /** Track the earliest event time ever loaded — the session's start time
   *  (converges to the true start as older pages load). */
  #noteEarliest(events) {
    let t = Infinity;
    for (const e of events ?? []) {
      const et = e?.event?.time;
      if (typeof et === "number" && et < t) t = et;
    }
    if (t !== Infinity && (this.earliestTime == null || t < this.earliestTime)) this.earliestTime = t;
  }
  syncTail(events) {
    const maxSeq = events[events.length - 1]?.event?.seq ?? 0;
    if (maxSeq <= (this.lastSyncedSeq ?? -1)) return;
    this.lastSyncedSeq = maxSeq;
    this.#noteEarliest(events);
    const nodes = nodeForEvents(events, this.app.log);
    const lastAssistant = [...nodes].reverse().find((n) => n.kind === "assistant");
    if (!lastAssistant) {
      for (const n of nodes) {
        if (n.kind === "user" && n.id && !this.nodes.some((x) => x.id === n.id)) {
          this.nodes.push(n);
          this.expanded.add(this.nodes.length - 1);
        }
      }
      this.queueRebuild();
      this.app.redraw();
      return;
    }
    const inheritStarts = (oldBlocks, newBlocks) => {
      for (let bi = 0; bi < (newBlocks ?? []).length; bi++) {
        const nb = newBlocks[bi];
        if (nb && nb.startedAt === void 0) {
          nb.startedAt = oldBlocks?.[bi]?.startedAt ?? Date.now();
        }
      }
    };
    const byId = lastAssistant.id ? [...this.nodes].reverse().find((n) => n.kind === "assistant" && n.id === lastAssistant.id) : null;
    if (byId) {
      inheritStarts(byId.blocks, lastAssistant.blocks);
      byId.blocks = lastAssistant.blocks;
      byId.streaming = lastAssistant.streaming;
      byId.finalized = !lastAssistant.streaming;
    } else {
      const mine = this.nodes[this.nodes.length - 1];
      if (mine?.kind === "assistant" && mine.streaming) {
        inheritStarts(mine.blocks, lastAssistant.blocks);
        mine.blocks = lastAssistant.blocks;
        mine.images = lastAssistant.images ?? mine.images;
        mine.id = lastAssistant.id ?? mine.id;
        mine.streaming = lastAssistant.streaming;
        mine.finalized = !lastAssistant.streaming;
      } else {
        for (const n of nodes) {
          if (n.kind !== "user" && n.kind !== "assistant") continue;
          const dup = n.id && this.nodes.some((x) => x.id === n.id);
          if (!dup) {
            this.nodes.push(n);
            this.expanded.add(this.nodes.length - 1);
          }
        }
      }
    }
    this.running = this.nodes.some((n) => (n.kind === "assistant" || n.kind === "turn-progress") && n.streaming);
    this.queueRebuild();
    this.app.redraw();
  }
  jumpToNode(idx) {
    this.flushRebuild();
    if (idx < 0 || idx >= this.nodes.length) return false;
    for (let li = 0; li < this.lineMap.length; li++) {
      if (this.lineMap[li]?.nodeIdx === idx) {
        this.view.anchorLock = null;
        this.view.follow = false;
        this.view.scrollY = Math.max(0, li - 2);
        const block = this.blockItems.findIndex((item) => item.nodeIdx === idx);
        if (block >= 0) {
          this.blockSel = block;
          this.cursor = { line: this.blockItems[block].headerLine, col: 0 };
        }
        this.app.redraw();
        return true;
      }
    }
    return false;
  }
  queueRebuild() {
    this.rebuildQueued = true;
  }
  flushRebuild() {
    if (this.rebuildQueued) {
      this.rebuildQueued = false;
      this.#rebuild();
    }
  }
  /** Height of the collapsible todo block: one framed row per visible task,
   *  capped at six items. Short lists must not reserve blank body rows. */
  todoHeight() {
    const todos = this.app.todos;
    const subagent = this.app.projections.subagent;
    const subagentRows = subagent ? 1 : 0;
    if (!todos || todos.length === 0) return subagentRows;
    return subagentRows + (this.todosVisible ? Math.min(todos.length, 6) + 2 : 2);
  }
  divingNode() {
    return [...this.nodes].reverse().find((node) => node.kind === "turn-progress") ?? null;
  }
  divingHeight() {
    return this.divingNode() ? 1 : 0;
  }
  inputChanged() {
    const th = this.todoHeight(), dh = this.divingHeight(), ah = this.attachments.length ? 1 : 0;
    const ih = Math.min(this.input.height(), Math.max(1, this.h - th - dh - ah - 2));
    const prevIh = this.input.h;
    this.input.h = ih;
    this.view.h = Math.max(1, this.h - ih - th - dh - ah - 1);
    this.input.y = this.y + this.h - ih;
    if (ih !== prevIh) this.app.layout();
    this.app.redraw();
  }
  resize(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    const th = this.todoHeight(), dh = this.divingHeight(), ah = this.attachments.length ? 1 : 0;
    const ih = Math.min(this.input.height(), Math.max(1, h - th - dh - ah - 2));
    this.input.h = ih;
    this.view.x = x;
    this.view.y = y;
    this.view.w = w;
    this.view.h = Math.max(1, h - ih - th - dh - ah - 1);
    this.input.x = x;
    this.input.y = y + h - ih;
    this.input.w = w;
    this.cache.clear();
    this.#rebuild();
  }
  async open(sessionId, epoch = this.app.sessionEpoch, maxMessages = 80) {
    this.sessionId = sessionId;
    this.nodes = [];
    this.welcomeModeSel = 0;
    this.blockSel = -1;
    this.cursorMode = "block";
    this.visualAnchor = null;
    this.expanded.clear();
    this.collapsedBlocks.clear();
    this.hasMore = false;
    this.minSeq = null;
    this.cache.clear();
    this.app.setStatus(`\u52A0\u8F7D\u4F1A\u8BDD ${sessionId.slice(0, 8)}\u2026`);
    try {
      const hist = await this.app.api.call("session.history", { sessionId, maxMessages });
      if (this.sessionId !== sessionId || this.app.sessionEpoch !== epoch) return;
      this.minSeq = hist.events[0]?.event?.seq ?? null;
      this.lastSeq = hist.events[hist.events.length - 1]?.event?.seq ?? null;
      this.lastSyncedSeq = -1;
      this.pollSlow = false;
      this.hasMore = hist.hasMore;
      this.#noteEarliest(hist.events);
      this.nodes = nodeForEvents(hist.events, this.app.log);
      this.title = hist.projections?.values?.title ?? this.title;
      if (hist.projections?.values) {
        this.app.projections = { ...this.app.projections, ...hist.projections.values };
      }
    } catch (e) {
      this.nodes = [{ kind: "system", text: `\u52A0\u8F7D\u5931\u8D25: ${e.message}` }];
    }
    this.inputChanged();
    this.#rebuild();
    this.view.anchorLock = null;
    this.view.scrollY = this.view.maxScroll();
    this.view.follow = true;
  }
  async loadOlder(onDone = null, maxMessages = 20) {
    if (!this.hasMore || this.loadingOlder || this.minSeq == null) {
      if (!this.hasMore) this.app.toast("\u5DF2\u52A0\u8F7D\u5230\u4F1A\u8BDD\u5F00\u5934");
      if (onDone) queueMicrotask(onDone);
      return;
    }
    const sessionId = this.sessionId;
    const epoch = this.app.sessionEpoch;
    this.loadingOlder = true;
    const oldTop = this.view.scrollY;
    const oldLength = this.lines.length;
    this.app.setStatus("\u52A0\u8F7D\u66F4\u65E9\u8BB0\u5F55\u2026");
    try {
      const hist = await this.app.api.call("session.history", { sessionId, beforeSeq: this.minSeq, maxMessages });
      if (this.sessionId !== sessionId || this.app.sessionEpoch !== epoch) {
        this.loadingOlder = false;
        return;
      }
      if (hist.events.length === 0) {
        this.hasMore = false;
      } else {
        const previousMinSeq = this.minSeq;
        this.minSeq = hist.events[0]?.event?.seq ?? this.minSeq;
        this.hasMore = hist.hasMore && this.minSeq < previousMinSeq;
        this.#noteEarliest(hist.events);
        const more = nodeForEvents(hist.events, this.app.log);
        const shift = more.length;
        if (shift > 0) {
          const shiftedExpanded = /* @__PURE__ */ new Set();
          for (const key of this.expanded) {
            if (typeof key === "number") shiftedExpanded.add(key + shift);
            else if (typeof key === "string" && /^(\d+):(\d+)$/.test(key)) {
              const [, ni, bi] = /^(\d+):(\d+)$/.exec(key);
              shiftedExpanded.add(`${Number(ni) + shift}:${bi}`);
            } else shiftedExpanded.add(key);
          }
          const shiftedCollapsed = /* @__PURE__ */ new Set();
          for (const key of this.collapsedBlocks) {
            const match = /^(\d+):(\d+)$/.exec(String(key));
            shiftedCollapsed.add(match ? `${Number(match[1]) + shift}:${match[2]}` : key);
          }
          this.expanded = shiftedExpanded;
          this.collapsedBlocks = shiftedCollapsed;
          this.cache.clear();
        }
        this.nodes = [...more, ...this.nodes];
      }
    } catch (e) {
      this.app.toast(`\u52A0\u8F7D\u66F4\u65E9\u5931\u8D25: ${e.message}`);
    }
    this.loadingOlder = false;
    this.#rebuild();
    const addedLines = Math.max(0, this.lines.length - oldLength);
    if (addedLines > 0) {
      this.view.follow = false;
      this.view.anchorLock = null;
      this.view.scrollY = Math.min(this.view.maxScroll(), oldTop + addedLines);
    }
    if (onDone) queueMicrotask(onDone);
  }
  /** [ / ] — jump the viewport to the END of the previous (dir -1) or next
   *  (dir +1) user question. `previous` walks to the question entirely above
   *  the viewport top (loading older history first when needed); `next` walks
   *  to the first question that starts below the viewport top. */
  #jumpQuestion(dir, allowLoad = true) {
    this.flushRebuild();
    const top = this.view.scrollY;
    const qs = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i]?.kind !== "user") continue;
      let first = -1, last = -1;
      for (let li = 0; li < this.lineMap.length; li++) {
        if (this.lineMap[li]?.nodeIdx === i) {
          if (first < 0) first = li;
          last = li;
        }
      }
      if (first < 0) continue;
      qs.push({ first, last });
    }
    let target = null;
    if (dir < 0) {
      for (let k = qs.length - 1; k >= 0; k--) {
        if (qs[k].last < top) {
          target = qs[k];
          break;
        }
      }
      if (!target && allowLoad && this.hasMore && this.minSeq != null) {
        void this.loadOlder(() => this.#jumpQuestion(-1, false));
        return true;
      }
    } else {
      target = qs.find((q) => q.first > top) ?? null;
    }
    if (!target) {
      this.app.toast(dir < 0 ? "\u5DF2\u5230\u6700\u65E9\u7684\u95EE\u9898" : "\u5DF2\u5230\u6700\u540E\u7684\u95EE\u9898");
      return false;
    }
    let end = target.last;
    while (end > target.first && !(this.lines[end] ?? []).some((g) => g.t.trim() !== "")) end--;
    this.view.anchorLock = null;
    this.view.follow = false;
    this.view.scrollY = Math.max(0, Math.max(target.first, end - 3));
    this.app.redraw();
    return true;
  }
  onFrame(frame) {
    if (frame.sessionId && frame.sessionId !== this.sessionId) return;
    switch (frame.type) {
      case "session/event": {
        this.mergeEvents([frame]);
        break;
      }
      case "session/title":
        this.title = frame.title ?? this.title;
        this.queueRebuild();
        break;
      case "session/jobs": {
        this.running = (frame.jobs ?? []).some((j) => j.status === "running");
        this.app.setJobs(frame.jobs ?? [], frame.sessionId);
        break;
      }
      case "session/subscribed": {
        if (this.minSeq == null) this.minSeq = frame.lastSeq;
        break;
      }
    }
  }
  pasteClipboardImage() {
    const acceptsImage = this.app.currentModel?.input?.includes?.("image") || this.app.currentModel?.input == null;
    if (!acceptsImage) {
      this.app.toast("\u5F53\u524D\u6A21\u578B\u672A\u58F0\u660E\u56FE\u7247\u8F93\u5165\u80FD\u529B");
      return false;
    }
    let image;
    try {
      image = clipboardImageFromWayland();
    } catch (e) {
      this.app.toast(`\u8BFB\u53D6\u56FE\u7247\u526A\u8D34\u677F\u5931\u8D25: ${e.message}`);
      return false;
    }
    if (!image) {
      this.app.toast("\u526A\u8D34\u677F\u4E2D\u6CA1\u6709 PNG/JPEG/WebP/GIF \u56FE\u7247");
      return false;
    }
    image.id = `clip-${Date.now()}-${this.attachments.length}`;
    image.local = false;
    this.clipboardImages.push(image);
    this.attachments.push(image);
    this.inputChanged();
    this.app.toast(`\u5DF2\u6DFB\u52A0\u56FE\u7247 ${image.name} \xB7 ${Math.round(image.bytes / 1024)}KB\uFF08NORMAL Ctrl+O \u7BA1\u7406\uFF09`);
    return true;
  }
  send(text) {
    if (!this.sessionId) return;
    const trimmed = text.trim();
    if (trimmed === "/reload") {
      this.app.softReload();
      return;
    }
    if (trimmed === "/restart") {
      this.app.restartApp();
      return;
    }
    if (trimmed === "/model") {
      this.app.overlay = buildModelPicker(this.app);
      this.app.redraw();
      return;
    }
    if (trimmed === "/theme") {
      cycleTheme();
      this.queueRebuild();
      this.app.toast(`\u4E3B\u9898\u5DF2\u5207\u6362: ${themeName()}`);
      return;
    }
    if (trimmed === "/permission") {
      this.app.showPermissionPicker();
      return;
    }
    if (trimmed === "/goal") {
      this.app.showGoal();
      return;
    }
    if (!trimmed && this.clipboardImages.length === 0) return;
    const { parts, images, errors } = buildPromptParts(trimmed, {
      readFile: (p) => {
        try {
          return (0, import_node_fs7.readFileSync)(p, "base64");
        } catch {
          return null;
        }
      }
    });
    for (const e of errors) this.app.toast(`\u56FE\u7247\u8BFB\u53D6\u5931\u8D25: ${e}`);
    const clipParts = this.clipboardImages.map(({ mediaType, data, name }) => ({ type: "image", mediaType, data, name }));
    const clipboardCount = clipParts.length;
    parts.push(...clipParts);
    this.app.log(`[chat] prompt \u2192 ${this.sessionId.slice(0, 8)}: ${truncate(trimmed, 60)}${images.length + clipboardCount ? ` (+${images.length + clipboardCount} \u56FE)` : ""}`);
    this.app.api.call("session.prompt", {
      sessionId: this.sessionId,
      mode: this.running ? busyEnter() : "queue",
      content: parts.filter((p) => p.type === "image" || (p.text ?? "").trim() !== ""),
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }).then((res) => {
      this.clipboardImages = [];
      this.attachments = [];
      if (res.command?.text) this.app.toast(res.command.text);
    }).catch((e) => this.app.toast(`\u53D1\u9001\u5931\u8D25: ${e.message}`));
  }
  /** File-based click diagnostics (DSH_TUI_DEBUG_CLICK=1): stderr lines are
   *  painted over by the next frame, so the trace goes to a log file. */
  #clickLog(msg) {
    try {
      const dir = stateRoot();
      (0, import_node_fs7.mkdirSync)(dir, { recursive: true });
      (0, import_node_fs7.appendFileSync)((0, import_node_path7.join)(dir, "tui-click-debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
    } catch {
    }
  }
  #clickLine(y, ev) {
    return this.#toggleAt(this.lineMap?.[y]);
  }
  /** Anchor context for a click: the clicked block's header line + its
   *  viewport row (primary anchor) and the viewport-top identity + offset
   *  (fallback for deep clicks). Captured at PRESS time so the stream cannot
   *  shift the hit identity between press and release (the 4-line mystery:
   *  the rendered frame and the hit test were consistent, but the identity
   *  was re-resolved at release against a stream that had moved). */
  #anchorCtx(info, pressY = null, pressX = null) {
    const lineKey = (m) => m ? `${m.nodeIdx}:${m.blockIdx ?? "n"}` : null;
    const topKey = lineKey(this.lineMap[this.view.scrollY]) ?? null;
    let topFirst = -1;
    if (topKey !== null) {
      for (let i = 0; i < this.lineMap.length; i++) {
        if (lineKey(this.lineMap[i]) === topKey) {
          topFirst = i;
          break;
        }
      }
    }
    const topOffset = topFirst >= 0 ? this.view.scrollY - topFirst : 0;
    const match = info?.blockIdx !== null ? (m) => m?.nodeIdx === info?.nodeIdx && m?.blockIdx === info?.blockIdx : (m) => m?.nodeIdx === info?.nodeIdx;
    const firstNonEmpty = (m) => {
      for (let i = 0; i < this.lineMap.length; i++) {
        if (m(this.lineMap[i]) && (this.lines[i] ?? []).some((g) => g.t.trim() !== "")) return i;
      }
      return -1;
    };
    const preHeaderIdx = info ? firstNonEmpty(match) : -1;
    const preHeaderRow = preHeaderIdx >= 0 ? preHeaderIdx - this.view.scrollY : null;
    const pressRow = pressY !== null && pressY !== void 0 && pressY >= 0 ? pressY - this.view.scrollY : null;
    const pressSeg = pressY !== null && pressY !== void 0 && pressY >= 0 ? this.#segAtLine(pressY, pressX) : null;
    let pressSig = null;
    if (info && info.blockIdx !== null) {
      const b = this.nodes[info.nodeIdx]?.blocks?.[info.blockIdx];
      if (b) pressSig = {
        nodeId: this.nodes[info.nodeIdx]?.id ?? null,
        kind: b.kind,
        prefix: String(b.text ?? b.args ?? "").slice(0, 40)
      };
    }
    return { lineKey, topKey, topFirst, topOffset, match, firstNonEmpty, preHeaderIdx, preHeaderRow, pressY, pressRow, pressX, pressSeg, pressSig };
  }
  /** The line-segment under a screen x on a rendered line (for the code
   *  block's [复制] button hit test). */
  #segAtLine(y, x) {
    const line = this.lines[y];
    if (!line || x == null || x < 0) return null;
    let px = this.view.x;
    for (const g of line) {
      const w = strWidth(g.t ?? "");
      if (x >= px && x < px + w) return g;
      px += w;
    }
    return null;
  }
  /** Toggle the block/node under a line-mark, then re-anchor the viewport.
   *  `info` must be the mark of the frame the user clicked on; `ctx` its
   *  press-time anchor context. */
  #toggleAt(info, ctx = null) {
    if (!info) return false;
    if (info.imgIdx !== void 0) {
      const node2 = this.nodes[info.nodeIdx];
      const ref = node2?.images?.[info.imgIdx];
      if (ref) {
        this.app.openImage(ref, { all: node2.images, index: info.imgIdx });
        return true;
      }
    }
    let node = this.nodes[info.nodeIdx];
    if (!node) return false;
    const { lineKey, topKey, topFirst, topOffset, match, firstNonEmpty, preHeaderIdx, preHeaderRow, pressY, pressRow, pressX, pressSeg, pressSig } = ctx ?? this.#anchorCtx(info);
    if (pressSeg?.copyCode) {
      this.app.copyText(pressSeg.copyCode);
      this.app.toast("\u5DF2\u590D\u5236\u4EE3\u7801\u5757");
      return true;
    }
    if (pressSig && info.blockIdx !== null) {
      const cur = node.blocks?.[info.blockIdx];
      const same = cur && cur.kind === pressSig.kind && String(cur.text ?? cur.args ?? "").slice(0, 40) === pressSig.prefix;
      if (!same) {
        let found = null;
        for (let ni = 0; ni < this.nodes.length && !found; ni++) {
          const n = this.nodes[ni];
          if (pressSig.nodeId && n?.id && n.id !== pressSig.nodeId) continue;
          for (let bi = 0; bi < (n?.blocks ?? []).length; bi++) {
            const b = n.blocks[bi];
            if (b.kind === pressSig.kind && String(b.text ?? b.args ?? "").slice(0, 40) === pressSig.prefix) {
              found = { nodeIdx: ni, blockIdx: bi };
              break;
            }
          }
        }
        if (found) {
          info = { ...info, ...found };
          node = this.nodes[found.nodeIdx];
        }
      }
    }
    if (node.kind === "assistant" && info.blockIdx !== null && node.blocks[info.blockIdx]?.kind === "text") {
      return true;
    }
    let collapsing = false;
    if (process.env.DSH_TUI_DEBUG_CLICK) {
      this.#clickLog(`toggle mark=${JSON.stringify(info)} kind=${node.kind} blockIdx=${info.blockIdx} preHeaderRow=${preHeaderRow} topKey=${topKey} topOffset=${topOffset}`);
    }
    const reanchor = () => {
      if (preHeaderRow !== null && preHeaderRow >= 0 && preHeaderIdx >= 0) {
        const h2 = firstNonEmpty(match);
        if (h2 >= 0) {
          const sy = h2 - preHeaderRow;
          this.view.scrollY = Math.max(0, sy);
          if (sy > this.view.maxScroll()) this.view.anchorLock = sy;
          return;
        }
      }
      if (topKey === null || topFirst < 0) return;
      let first = -1, last = -1;
      for (let i = 0; i < this.lineMap.length; i++) {
        if (lineKey(this.lineMap[i]) !== topKey) continue;
        if (first < 0) first = i;
        last = i;
      }
      if (first < 0) return;
      const target = Math.min(first + topOffset, last);
      this.view.scrollY = Math.max(0, target);
      if (target > this.view.maxScroll()) this.view.anchorLock = target;
    };
    const nudge = () => {
      while (this.view.scrollY < this.lineMap.length - 1 && !(this.lines[this.view.scrollY] ?? []).some((g) => g.t.trim() !== "") && (this.lineMap[this.view.scrollY]?.blockIdx ?? null) === null) this.view.scrollY++;
    };
    this.view.follow = false;
    if (info.dispatchId != null) {
      const dkey = `disp:${info.dispatchId}`;
      if (this.expanded.has(dkey)) this.expanded.delete(dkey);
      else this.expanded.add(dkey);
      this.#rebuild();
      reanchor();
      nudge();
      return true;
    }
    if (node.kind === "assistant" && info.blockIdx !== null) {
      const b = node.blocks[info.blockIdx];
      if (b && (b.kind === "tool" || b.kind === "reasoning" || b.kind === "other" || b.kind === "text")) {
        const key = `${info.nodeIdx}:${info.blockIdx}`;
        if (b.kind === "reasoning") {
          const open = this.expanded.has(key) || !this.collapsedBlocks.has(key) && this.thinkMode === "expanded";
          collapsing = open;
          if (open) {
            this.expanded.delete(key);
            this.collapsedBlocks.add(key);
          } else {
            this.collapsedBlocks.delete(key);
            this.expanded.add(key);
          }
        } else if (b.kind === "tool") {
          const open = this.expanded.has(key) || this.bashMode !== "collapsed" && !this.collapsedBlocks.has(key);
          collapsing = open;
          if (open) {
            this.expanded.delete(key);
            this.collapsedBlocks.add(key);
          } else {
            this.collapsedBlocks.delete(key);
            this.expanded.add(key);
          }
        } else {
          collapsing = !this.collapsedBlocks.has(key);
          if (this.collapsedBlocks.has(key)) this.collapsedBlocks.delete(key);
          else this.collapsedBlocks.add(key);
        }
        this.#rebuild();
        reanchor();
        nudge();
        if (process.env.DSH_TUI_DEBUG_CLICK) {
          const t = this.lines[this.view.scrollY]?.map((g) => g.t).join("") ?? "";
          this.#clickLog(`after scrollY=${this.view.scrollY} topKey="${topKey}" topText="${t.slice(0, 40)}"`);
        }
        return true;
      }
    }
    if (["assistant", "user", "context", "goal-round", "subagent-receipt"].includes(node.kind)) {
      if (this.expanded.has(info.nodeIdx)) this.expanded.delete(info.nodeIdx);
      else this.expanded.add(info.nodeIdx);
      this.#rebuild();
      reanchor();
      nudge();
      return true;
    }
    return false;
  }
  #rebuild() {
    const oldBlock = this.blockItems?.[this.blockSel] ?? null;
    const oldIdentity = oldBlock ? `${oldBlock.nodeKey}:${oldBlock.blockIdx ?? "n"}:${oldBlock.kind}:${oldBlock.codeIndex ?? "-"}` : null;
    const w = Math.max(20, this.view.w - 2);
    let lines = [];
    const lineMap = [];
    this.cardRanges = [];
    const mark = (nodeIdx, blockIdx = null, dispatchId = null) => lineMap.push(dispatchId != null ? { nodeIdx, blockIdx, dispatchId } : { nodeIdx, blockIdx });
    const markImg = (nodeIdx, imgIdx) => lineMap.push({ nodeIdx, imgIdx });
    const skipCount = 0;
    const nodes = this.nodes;
    lines.push([{ t: truncate(this.title || this.sessionId?.slice(0, 8) || "", w - 2), fg: K2.DIM }]);
    mark(-1);
    if (this.hasMore) {
      lines.push([{ t: "\u25B2 \u66F4\u65E9\u7684\u8BB0\u5F55", fg: K2.FAINT }]);
      mark(-1);
    }
    if (skipCount > 0) {
      lines.push([{ t: `\u2026 \u66F4\u65E9 ${skipCount} \u6761\u8BB0\u5F55\uFF08PgUp \u52A0\u8F7D\uFF09`, fg: K2.FAINT }]);
      mark(-1);
    }
    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      const realIdx = ni + skipCount;
      const expKey = this.expanded.has(realIdx) ? "1" : "0";
      const blockKeys = node.kind === "assistant" && node.blocks ? node.blocks.map((b, bi) => {
        const key = `${realIdx}:${bi}`;
        if (this.collapsedBlocks.has(key)) return "c";
        if (this.expanded.has(key)) return "e";
        return ".";
      }).join("") : "";
      const dispKey = (() => {
        if (node.kind !== "assistant" || !node.blocks) return "";
        const ids = [];
        forEachDispatch(node, (c) => {
          if (this.expanded.has(`disp:${c.callId}`)) ids.push(c.callId);
        });
        return ids.sort().join(",");
      })();
      const ckey = `${realIdx}|${w}|${expKey}|${blockKeys}|${dispKey}|${this.thinkMode}|${this.bashMode}|${node.streaming ? "s" : "f"}|${themeName()}|${node.step ?? "-"}|${userPrefix()}|${node.turnMs ?? "-"}`;
      const hit = node.streaming || this.running && realIdx === this.nodes.length - 1 ? void 0 : this.cache.get(ckey);
      if (hit) {
        for (const [rs, re, bg] of hit.cards ?? []) {
          this.cardRanges.push([lines.length + rs, lines.length + re, bg]);
        }
        for (const ln of hit.lines) lines.push(ln);
        for (const mk of hit.marks) lineMap.push({ ...mk });
        continue;
      }
      const cacheStart = lines.length;
      const markStart = lineMap.length;
      const nodeCards = [];
      let openCard = null;
      const beginCard = (bgName) => {
        openCard = { start: lines.length, bg: T[bgName] };
      };
      const endCard = () => {
        if (openCard === null) return;
        const card = openCard;
        openCard = null;
        const end = lines.length - 1;
        if (end >= card.start) {
          for (let li = card.start; li <= end; li++) {
            lines[li] = lines[li].map((g) => ({ ...g, bg: g.bg ?? card.bg }));
          }
          nodeCards.push([card.start - cacheStart, end - cacheStart, card.bg]);
          this.cardRanges.push([card.start, end, card.bg]);
        }
      };
      const sep = () => {
        endCard();
        lines.push([{ t: "" }]);
        mark(realIdx);
      };
      const renderNode = () => {
        switch (node.kind) {
          case "title":
            lines.push([{ t: "\u2726 " + truncate(node.text, w - 4), fg: K2.DIM, italic: true }]);
            mark(realIdx);
            break;
          case "system":
            lines.push([{ t: truncate(node.text, w - 2), fg: K2.WARN }]);
            mark(realIdx);
            break;
          case "turn-progress":
            break;
          // rendered as a fixed transcript-bottom status row
          case "retry":
            lines.push([{ t: `  \u21BB ${node.status === "started" ? "\u6B63\u5728\u91CD\u8BD5" : `\u51C6\u5907\u91CD\u8BD5${node.delayMs ? `\uFF08${fmtDuration(node.delayMs)} \u540E\uFF09` : ""}`}\uFF1A${truncate(node.text, w - 20)}`, fg: K2.WARN, bold: node.status === "started" }]);
            mark(realIdx);
            break;
          case "command":
            lines.push([{ t: `  ${node.status === "running" ? "\u2026" : node.status === "error" ? "\u2717" : "\u2713"} ${node.text}${node.detail ? ` \u2014 ${truncate(node.detail, w - strWidth(node.text) - 10)}` : ""}`, fg: node.status === "error" ? K2.ERR : node.status === "success" ? K2.OK : K2.DIM }]);
            mark(realIdx);
            break;
          case "steering":
            lines.push([{ t: "  \u21AA \u5DF2\u8FFD\u52A0\u5230\u5F53\u524D\u56DE\u5408 > ", fg: K2.ACCENT, bold: true }, { t: truncate(node.text, w - 22), fg: K2.TXT }]);
            mark(realIdx);
            break;
          case "turn-error":
            lines.push([{ t: `  \u2717 ${node.text}${node.code ? ` (${node.code})` : ""}`, fg: K2.ERR, bold: true }]);
            mark(realIdx);
            break;
          case "turn-max-tokens":
            lines.push([{ t: `  \u26A0 ${node.text}`, fg: T.WARN, bold: true }]);
            mark(realIdx);
            break;
          case "goal-round":
          case "subagent-receipt":
          case "context": {
            const isExp = this.expanded.has(realIdx);
            const text = node.text ?? "";
            const summary = node.source?.summary;
            const label = node.kind === "goal-round" ? `\u{1F3AF} \u76EE\u6807\u7EED\u8F6E ${node.source?.round ?? ""}` : node.kind === "subagent-receipt" ? node.source?.kind === "subagent-settled" ? "\u25C7 \u5B50\u4EE3\u7406\u72B6\u6001" : "\u25C7 \u5B50\u4EE3\u7406\u56DE\u6267" : `\u2139 \u4E0A\u4E0B\u6587 \xB7 ${node.source?.kind ?? "\u6CE8\u5165"}`;
            beginCard(node.kind === "goal-round" ? "THINKBG" : "CARD");
            lines.push([{ t: `  ${label}${summary ? ` \u2014 ${truncate(summary, w - strWidth(label) - 8)}` : ""}`, fg: node.kind === "subagent-receipt" ? T.PURPLE : K2.DIM, bold: true }]);
            mark(realIdx);
            if (node.source?.form !== "notice" || isExp) {
              for (const ln of renderMd(isExp ? text : truncateText(text, 600), Math.max(10, w - 4))) {
                lines.push([{ t: "  " }, ...ln]);
                mark(realIdx);
              }
            } else if (text && !summary) {
              lines.push([{ t: "  " + truncate(text.replace(/\s+/g, " "), w - 4), fg: K2.FAINT }]);
              mark(realIdx);
            }
            if (text.length > 600 || node.source?.form === "notice") {
              lines.push([{ t: isExp ? "  [\u70B9\u51FB\u6298\u53E0]" : "  [\u70B9\u51FB\u5C55\u5F00]", fg: K2.FAINT }]);
              mark(realIdx);
            }
            sep();
            break;
          }
          case "user": {
            const isExp = this.expanded.has(realIdx);
            const text = node.text ?? "";
            const shown = isExp ? text : text.slice(0, 2e3);
            beginCard("USERBG");
            const prefix = userPrefix();
            const pw = strWidth(prefix);
            const md = renderMd(shown, Math.max(10, w - 4 - pw), null, { hardBreaks: true });
            if (md.length === 0) {
              lines.push([{ t: "  " + prefix, fg: K2.OK, bold: true }]);
              mark(realIdx);
            } else {
              lines.push([{ t: "  " + prefix, fg: K2.OK, bold: true }, ...md[0]]);
              mark(realIdx);
              for (const ln of md.slice(1)) {
                lines.push([{ t: "  " + " ".repeat(pw) }, ...ln]);
                mark(realIdx);
              }
            }
            if (!isExp && text.length > 2e3) {
              lines.push([{ t: "  \u2026", fg: K2.FAINT }]);
              mark(realIdx);
            }
            if (node.images) {
              for (let ii = 0; ii < node.images.length; ii++) {
                const img = node.images[ii];
                lines.push([{ t: "  \u25A3 " + truncate(img.name ?? img.attachmentId ?? "image", w - 12) + (img.width ? ` (${img.width}\xD7${img.height})` : "") + " \u2014 \u70B9\u51FB\u67E5\u770B", fg: T.PURPLE }]);
                markImg(realIdx, ii);
              }
            }
            sep();
            break;
          }
          case "assistant": {
            const blocks = node.blocks ?? [];
            if (blocks.length === 0) {
              lines.push([{ t: "  \u2026", fg: K2.FAINT }]);
              mark(realIdx);
              break;
            }
            for (let bi = 0; bi < blocks.length; bi++) {
              const b = blocks[bi];
              const stepTag = node.step != null ? ` (step ${node.step})` : "";
              if (b.kind === "reasoning") {
                const key = `${realIdx}:${bi}`;
                const manuallyCollapsed = this.collapsedBlocks.has(key);
                const manuallyExpanded = this.expanded.has(key);
                const open = manuallyExpanded || !manuallyCollapsed && this.thinkMode === "expanded";
                beginCard("THINKBG");
                let timing = "";
                if (b.streaming) {
                  timing = ` \u5DF2\u7ECF\u8FC7 ${fmtDuration(Date.now() - (b.startedAt ?? Date.now()))}`;
                } else if (b.startedAt !== void 0 && b.endedAt !== void 0) {
                  timing = ` \u5DF2\u5B8C\u6210,\u8017\u65F6 ${fmtDuration(b.endedAt - b.startedAt)}`;
                } else if (b.endedAt !== void 0) {
                  timing = " \u5DF2\u5B8C\u6210";
                }
                const thinkMeta = `${stepTag}\uFF08${b.text?.length ?? 0} \u5B57\uFF09${timing}`;
                lines.push([{ t: "\u{1F4AD} \u601D\u8003" + (b.streaming ? "\u2026" : "") + thinkMeta + (open ? " [t \u6298\u53E0]" : " [t \u5C55\u5F00]"), fg: K2.FAINT }]);
                mark(realIdx, bi);
                if (open) {
                  for (const ln of renderMd(b.text ?? "", w - 4)) {
                    lines.push([{ t: "  " }, ...ln]);
                    mark(realIdx, bi);
                  }
                } else {
                  for (const ln of renderMd(truncateText(b.text, 400), w - 4).slice(0, 3)) {
                    lines.push([{ t: "  " }, ...ln.map((g) => ({ ...g, fg: K2.FAINT }))]);
                    mark(realIdx, bi);
                  }
                }
                sep();
              } else if (b.kind === "tool") {
                const key = `${realIdx}:${bi}`;
                const open = this.expanded.has(key) || this.bashMode !== "collapsed" && !this.collapsedBlocks.has(key);
                const cardView = b.resultView ?? b.view;
                const exitCode = cardView?.exitCode;
                const signal = cardView?.signal;
                const running = b.result == null && !b.done && node.streaming;
                const orphan = b.result == null && !b.done && !node.streaming;
                const stopped = !running && (b.stopped || signal === "SIGTERM" || signal === "SIGINT");
                const failed = !orphan && !stopped && (b.isError || signal || exitCode !== void 0 && exitCode !== 0);
                const status = "CARD";
                const glyph = running ? "\u23F3" : failed ? "!" : stopped ? "\u23F8" : orphan ? "\u25CC" : "\u2713";
                const card = cardView ? renderToolCard(cardView, w, open) : [];
                beginCard(status);
                let timing = "";
                if (running) {
                  timing = ` \u5DF2\u7ECF\u8FC7 ${fmtDuration(Date.now() - (b.startedAt ?? Date.now()))}`;
                } else if (b.startedAt !== void 0 && b.endedAt !== void 0) {
                  timing = ` ${failed ? "\u5931\u8D25" : stopped ? "\u5DF2\u505C\u6B62" : orphan ? "\u7ED3\u679C\u672A\u4FDD\u7559" : "\u5DF2\u5B8C\u6210"},\u8017\u65F6 ${orphan ? "\u2264" : ""}${fmtDuration(b.endedAt - b.startedAt)}`;
                } else if (orphan) {
                  timing = " \u7ED3\u679C\u672A\u4FDD\u7559";
                }
                lines.push([
                  { t: open ? "\u25BE " : "\u25B8 ", fg: K2.ACCENT },
                  { t: ` ${b.name ?? "tool"}`, fg: K2.TXT, bold: true },
                  { t: ` ${glyph}`, fg: failed ? K2.WARN : running ? K2.DIM : K2.OK },
                  { t: stepTag + timing, fg: K2.DIM },
                  { t: open ? " [b \u6298\u53E0]" : " [b \u5C55\u5F00]", fg: K2.FAINT }
                ]);
                mark(realIdx, bi);
                if (!open) {
                  const summary = toolSummary(b);
                  if (summary) {
                    lines.push([{ t: "  " + truncate(summary, w - 6), fg: K2.FAINT }]);
                    mark(realIdx, bi);
                  }
                }
                if (open) {
                  for (const ln of card) {
                    lines.push(ln);
                    mark(realIdx, bi);
                  }
                  if (b.args) {
                    for (const ln of jsonPreview(b.args, w, open)) {
                      lines.push(ln);
                      mark(realIdx, bi);
                    }
                  }
                  if (b.result != null) {
                    lines.push([{ t: "  \u7ED3\u679C:", fg: K2.DIM, underline: true }]);
                    mark(realIdx, bi);
                    const rl = truncateText(b.result, 4e3).split("\n");
                    for (const r of rl.slice(0, 30)) {
                      lines.push([{ t: "  " + truncate(r, w - 4), fg: K2.DIM }]);
                      mark(realIdx, bi);
                    }
                    if (rl.length > 30) {
                      lines.push([{ t: `  \u2026\u5171 ${rl.length} \u884C`, fg: K2.FAINT }]);
                      mark(realIdx, bi);
                    }
                  } else if (orphan) {
                    lines.push([{ t: "  \u7ED3\u679C\u672A\u4FDD\u7559\uFF1A\u8BE5\u5DE5\u5177\u8C03\u7528\u7684\u7ED3\u679C\u4E0D\u5728\u5F53\u524D\u4F1A\u8BDD\u5386\u53F2\u4E2D\uFF08\u4E0A\u4E0B\u6587\u538B\u7F29\u4F1A\u4FEE\u526A\u65E9\u671F\u5DE5\u5177\u7ED3\u679C\uFF09\uFF0C\u5E76\u975E\u6267\u884C\u5931\u8D25\u6216\u8F93\u51FA\u4E3A\u7A7A\u3002", fg: K2.FAINT }]);
                    mark(realIdx, bi);
                  }
                  const subCalls = Array.isArray(b.subCalls) ? b.subCalls : [];
                  if (subCalls.length) {
                    lines.push([{ t: `  \u2500 \u5B50\u8C03\u5EA6 ${countDispatch(b)} \u9879`, fg: K2.FAINT }]);
                    mark(realIdx, bi);
                    const budget = { nodes: 0, lines: 0 };
                    const renderDispatches = (children, depth) => {
                      if (depth > DISPATCH_MAX_DEPTH) return;
                      for (const c of children) {
                        if (budget.nodes >= DISPATCH_MAX_NODES || budget.lines >= DISPATCH_RENDER_LINES) {
                          lines.push([{ t: "  \u2026\u5B50\u8C03\u5EA6\u8FC7\u591A\uFF08\u5DF2\u622A\u65AD\uFF09", fg: K2.FAINT }]);
                          mark(realIdx, bi);
                          return;
                        }
                        budget.nodes++;
                        const dkey = `disp:${c.callId}`;
                        const dOpen = this.expanded.has(dkey);
                        const indent = "  ".repeat(Math.min(depth, DISPATCH_MAX_DEPTH) + 1);
                        const running2 = c.result == null && c.endedAt == null;
                        const glyph2 = dOpen ? "\u25BE" : "\u25B8";
                        const status2 = running2 ? "\u23F3" : c.isError ? "\u2717" : "\u2713";
                        let timing2 = "";
                        if (c.startedAt !== void 0 && c.endedAt !== void 0) {
                          timing2 = ` \u5DF2\u5B8C\u6210,\u8017\u65F6 ${fmtDuration(c.endedAt - c.startedAt)}`;
                        }
                        lines.push([
                          { t: indent + glyph2 + " ", fg: K2.ACCENT },
                          { t: c.name ?? "subtool", fg: K2.TXT, bold: true },
                          { t: ` ${status2}`, fg: running2 ? K2.WARN : c.isError ? K2.ERR : K2.OK },
                          { t: timing2, fg: K2.DIM },
                          { t: dOpen ? " [b \u6298\u53E0]" : " [b \u5C55\u5F00]", fg: K2.FAINT }
                        ]);
                        mark(realIdx, bi, c.callId);
                        budget.lines++;
                        if (!dOpen) {
                          const summary = toolSummary(c);
                          if (summary) {
                            lines.push([{ t: indent + "  " + truncate(summary, Math.max(8, w - 4 - strWidth(indent + "  "))), fg: K2.FAINT }]);
                            mark(realIdx, bi, c.callId);
                            budget.lines++;
                          }
                        } else {
                          if (c.args) {
                            for (const ln of jsonPreview(c.args, w, true)) {
                              lines.push([{ t: indent + "  " }, ...ln.map((g) => ({ ...g }))]);
                              mark(realIdx, bi, c.callId);
                              budget.lines++;
                            }
                          }
                          if (c.result != null && c.result !== "") {
                            lines.push([{ t: indent + "  \u7ED3\u679C:", fg: K2.DIM, underline: true }]);
                            mark(realIdx, bi, c.callId);
                            budget.lines++;
                            const rl = c.result.split("\n");
                            for (const r of rl.slice(0, 20)) {
                              lines.push([{ t: indent + "  " + truncate(r, Math.max(8, w - 4 - strWidth(indent + "  "))), fg: K2.DIM }]);
                              mark(realIdx, bi, c.callId);
                              budget.lines++;
                            }
                            if (rl.length > 20) {
                              lines.push([{ t: indent + `  \u2026\u5171 ${rl.length} \u884C`, fg: K2.FAINT }]);
                              mark(realIdx, bi, c.callId);
                              budget.lines++;
                            }
                          }
                          renderDispatches(c.subCalls ?? [], depth + 1);
                        }
                      }
                    };
                    renderDispatches(subCalls, 0);
                  }
                }
                sep();
              } else if (b.kind === "other") {
                beginCard("THINKBG");
                lines.push([{ t: "  " + stepTag + truncate(b.text, w - 4 - strWidth(stepTag)), fg: K2.DIM }]);
                mark(realIdx, bi);
                sep();
              } else {
                beginCard("TOOLOK");
                const key = `${realIdx}:${bi}`;
                const text = b.text ?? "";
                const mdW = Math.max(10, w - 6 - strWidth(stepTag));
                const sink = { codeBlocks: [] };
                const md = renderMd(text, mdW, sink);
                const assistantMark = { t: "  \u25C6", fg: K2.ACCENT, bold: true };
                const step = { t: stepTag || " ", fg: K2.FAINT };
                if (md.length > 0) {
                  const firstIsBoxTop = md[0].some((g) => g.copyCode);
                  if (firstIsBoxTop) {
                    lines.push([assistantMark, step]);
                    mark(realIdx, bi);
                    for (const ln of md) {
                      lines.push([{ t: "  " }, ...ln]);
                      mark(realIdx, bi);
                    }
                  } else {
                    lines.push([assistantMark, step, ...md[0]]);
                    mark(realIdx, bi);
                    for (const ln of md.slice(1)) {
                      lines.push([{ t: "  " }, ...ln]);
                      mark(realIdx, bi);
                    }
                  }
                } else {
                  lines.push([assistantMark, step]);
                  mark(realIdx, bi);
                }
                sep();
              }
            }
            if (node.images) {
              for (let ii = 0; ii < node.images.length; ii++) {
                const img = node.images[ii];
                beginCard("CARD");
                lines.push([{ t: "  \u25A3 " + truncate(img.name ?? img.attachmentId ?? "image", w - 12) + (img.width ? ` (${img.width}\xD7${img.height})` : "") + " \u2014 \u70B9\u51FB\u67E5\u770B", fg: T.PURPLE }]);
                markImg(realIdx, ii);
                sep();
              }
            }
            break;
          }
          default:
            lines.push([{ t: "  " + truncate(JSON.stringify(node).slice(0, 100), w - 4), fg: K2.FAINT }]);
            mark(realIdx);
        }
      };
      renderNode();
      endCard();
      lines.push([{ t: "" }]);
      mark(realIdx);
      if (!node.streaming) this.cache.set(ckey, {
        lines: lines.slice(cacheStart),
        marks: lineMap.slice(markStart),
        cards: nodeCards
      });
      if (this.cache.size > 400) {
        for (const k of this.cache.keys()) {
          this.cache.delete(k);
          if (this.cache.size <= 300) break;
        }
      }
    }
    const q = this.app.searchQuery;
    if (q) {
      const lower = q.toLowerCase();
      lines = lines.map((ln) => ln.flatMap((seg) => {
        if (!seg.t) return [seg];
        const low = seg.t.toLowerCase();
        if (!low.includes(lower)) return [seg];
        const parts = [];
        let idx = 0;
        while (true) {
          const i = low.indexOf(lower, idx);
          if (i === -1) {
            if (idx < seg.t.length) parts.push({ ...seg, t: seg.t.slice(idx) });
            break;
          }
          if (i > idx) parts.push({ ...seg, t: seg.t.slice(idx, i) });
          parts.push({ ...seg, t: seg.t.slice(i, i + q.length), bg: T.WARN, fg: T.SELFG });
          idx = i + q.length;
        }
        return parts;
      }));
    }
    this.lines = lines;
    this.lineMap = lineMap;
    this.#rebuildBlockItems(oldIdentity);
    if (process.env.DSH_TUI_DEBUG_CLICK && lineMap.length !== lines.length) {
      this.#clickLog(`INVARIANT BROKEN: lines=${lines.length} lineMap=${lineMap.length}`);
    }
    this.view.setLines(lines);
  }
  #rebuildBlockItems(oldIdentity = null) {
    const items = [];
    const nonBlank = (line) => (this.lines[line] ?? []).some((seg) => (seg.t ?? "").trim() !== "");
    const keyOf = (mark) => {
      if (!mark || mark.nodeIdx == null || mark.nodeIdx < 0) return null;
      if (mark.imgIdx !== void 0) return `${mark.nodeIdx}:img:${mark.imgIdx}`;
      if (mark.dispatchId != null) return `${mark.nodeIdx}:${mark.blockIdx}:dispatch:${mark.dispatchId}`;
      return `${mark.nodeIdx}:${mark.blockIdx ?? "node"}`;
    };
    for (let start = 0; start < this.lineMap.length; ) {
      const key = keyOf(this.lineMap[start]);
      if (key === null) {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < this.lineMap.length && keyOf(this.lineMap[end]) === key) end++;
      const mark = this.lineMap[start];
      const node = this.nodes[mark.nodeIdx];
      let first = -1, last = -1;
      for (let line = start; line < end; line++) if (nonBlank(line)) {
        if (first < 0) first = line;
        last = line;
      }
      if (first >= 0 && node) {
        const block = mark.blockIdx != null ? node.blocks?.[mark.blockIdx] : null;
        const baseKind = mark.imgIdx !== void 0 ? "image" : mark.dispatchId != null ? "tool" : block?.kind ?? node.kind;
        const nodeKey = node.id ?? `seq:${node.firstSeq ?? "?"}:${node.kind}`;
        const base = { first, last, headerLine: first, nodeIdx: mark.nodeIdx, nodeKey, blockIdx: mark.blockIdx ?? null, kind: baseKind, foldable: false, code: null };
        if (block?.kind === "reasoning" || block?.kind === "tool" || mark.dispatchId != null) base.foldable = true;
        else if (!block && ["user", "context", "goal-round", "subagent-receipt"].includes(node.kind)) base.foldable = true;
        if (block?.kind === "text") {
          const ranges = [];
          let codeIndex = 0;
          for (let line = first; line <= last; line++) {
            const codeSeg = (this.lines[line] ?? []).find((seg) => seg.codeBlock || seg.copyCode);
            const meta = codeSeg?.codeBlock;
            if (!meta) continue;
            const prev = ranges.at(-1);
            if (prev?.meta === meta && line === prev.last + 1) prev.last = line;
            else ranges.push({ first: line, last: line, meta, codeIndex: codeIndex++ });
          }
          let cursor = first;
          for (const range of ranges) {
            let proseEnd = range.first - 1;
            while (proseEnd >= cursor && !nonBlank(proseEnd)) proseEnd--;
            if (proseEnd >= cursor) items.push({ ...base, first: cursor, last: proseEnd, headerLine: cursor, kind: "text" });
            items.push({ ...base, first: range.first, last: range.last, headerLine: range.first, kind: "code", codeIndex: range.codeIndex, code: { text: range.meta.text ?? "", lang: range.meta.lang ?? "text" } });
            cursor = range.last + 1;
          }
          while (cursor <= last && !nonBlank(cursor)) cursor++;
          if (cursor <= last) items.push({ ...base, first: cursor, last, headerLine: cursor, kind: "text" });
          if (ranges.length === 0) items.push(base);
        } else items.push(base);
      }
      start = end;
    }
    this.blockItems = items;
    let next = oldIdentity == null ? -1 : items.findIndex((item) => `${item.nodeKey}:${item.blockIdx ?? "n"}:${item.kind}:${item.codeIndex ?? "-"}` === oldIdentity);
    if (next < 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (["text", "code", "user"].includes(items[i].kind)) {
          next = i;
          break;
        }
      }
      if (next < 0) next = items.length - 1;
    }
    this.blockSel = next;
    const selected = items[next];
    if (selected && this.cursorMode === "block") this.cursor = { line: selected.headerLine, col: Math.max(0, strWidth(this.#lineText(selected.headerLine)) - 1) };
  }
  #lineText(line) {
    return (this.lines[line] ?? []).map((seg) => seg.t ?? "").join("");
  }
  #scrollToTranscriptLine(line) {
    this.view.follow = false;
    this.view.anchorLock = null;
    if (line < this.view.scrollY) this.view.scrollY = line;
    else if (line >= this.view.scrollY + this.view.h) this.view.scrollY = Math.max(0, line - this.view.h + 1);
  }
  #moveBlock(delta) {
    if (this.blockItems.length === 0) return false;
    const base = this.blockSel < 0 ? delta > 0 ? -1 : 0 : this.blockSel;
    const next = base + delta;
    if (next < 0 || next >= this.blockItems.length) return true;
    this.blockSel = next;
    const item = this.blockItems[this.blockSel];
    this.cursor = { line: item.headerLine, col: 0 };
    if (this.cursorMode !== "block") this.#syncKeyboardSelection();
    this.#scrollToTranscriptLine(item.headerLine);
    this.app.redraw();
    return true;
  }
  #syncKeyboardSelection() {
    if (this.cursorMode !== "visual" && this.cursorMode !== "visual-line") {
      this.selStart = this.selEnd = null;
      this.selAnchor = this.selFocus = null;
      return;
    }
    const anchor = this.visualAnchor ?? this.cursor;
    let a = { ...anchor }, b = { ...this.cursor };
    if (this.cursorMode === "visual-line") {
      a.col = 0;
      b.col = Math.max(0, strWidth(this.#lineText(b.line)) - 1);
    }
    this.selAnchor = a;
    this.selFocus = b;
    this.selStart = Math.min(a.line, b.line);
    this.selEnd = Math.max(a.line, b.line);
  }
  #cursorStops(line = this.cursor.line) {
    const chars = graphemes(this.#lineText(line));
    const stops = [];
    let col = 0;
    for (const char of chars) {
      stops.push({ char, col, width: Math.max(1, graphemeWidth(char)) });
      col += graphemeWidth(char);
    }
    if (stops.length === 0) stops.push({ char: "", col: 0, width: 1 });
    return stops;
  }
  #cursorStopIndex(stops = this.#cursorStops()) {
    let index = 0;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].col <= this.cursor.col) index = i;
      else break;
    }
    return index;
  }
  #moveCursorHorizontal(delta) {
    const stops = this.#cursorStops();
    const index = Math.max(0, Math.min(stops.length - 1, this.#cursorStopIndex(stops) + delta));
    this.cursor.col = stops[index].col;
    this.#syncKeyboardSelection();
    this.app.redraw();
    return true;
  }
  #wordMotion(kind) {
    const stops = this.#cursorStops();
    let pos = this.#cursorStopIndex(stops);
    const word = (entry) => /[\p{L}\p{N}_]/u.test(entry?.char ?? "");
    if (kind === "w") {
      while (pos < stops.length && word(stops[pos])) pos++;
      while (pos < stops.length && !word(stops[pos])) pos++;
    } else if (kind === "b") {
      pos = Math.max(0, pos - 1);
      while (pos > 0 && !word(stops[pos])) pos--;
      while (pos > 0 && word(stops[pos - 1])) pos--;
    } else {
      while (pos + 1 < stops.length && !word(stops[pos])) pos++;
      while (pos + 1 < stops.length && word(stops[pos + 1])) pos++;
    }
    this.cursor.col = stops[Math.max(0, Math.min(stops.length - 1, pos))].col;
    this.#syncKeyboardSelection();
    this.app.redraw();
    return true;
  }
  #selectedTranscriptText() {
    if (this.cursorMode === "block" || this.cursorMode === "normal") {
      const item = this.blockItems[this.blockSel];
      if (!item) return "";
      if (item.kind === "code") return item.code?.text ?? "";
      const node = this.nodes[item.nodeIdx];
      const block = item.blockIdx != null ? node?.blocks?.[item.blockIdx] : null;
      if (block) return [block.text ?? block.args ?? "", block.kind === "tool" && block.result != null ? block.result : ""].filter(Boolean).join("\n");
      return node?.text ?? "";
    }
    const a = this.selAnchor, b = this.selFocus;
    if (!a || !b) return "";
    const first = a.line < b.line || a.line === b.line && a.col <= b.col ? a : b;
    const last = first === a ? b : a;
    const cut = (text, from, to) => {
      let out = "", col = 0;
      for (const g of graphemes(text)) {
        const next = col + graphemeWidth(g);
        if (next > from && col <= to) out += g;
        col = next;
      }
      return out;
    };
    return this.lines.slice(first.line, last.line + 1).map((line, index, all) => cut(line.map((seg) => seg.t ?? "").join(""), index === 0 ? first.col : 0, index === all.length - 1 ? last.col : Infinity)).join("\n");
  }
  #yankTranscript() {
    const text = this.#selectedTranscriptText();
    if (!text) {
      this.app.toast("\u672A\u9009\u4E2D\u53EF\u590D\u5236\u5185\u5BB9");
      return true;
    }
    this.app.copyText(text);
    this.app.toast(this.cursorMode === "block" || this.cursorMode === "normal" ? this.blockItems[this.blockSel]?.kind === "code" ? "\u5DF2\u590D\u5236\u4EE3\u7801\u5757" : "\u5DF2\u590D\u5236\u6B63\u6587\u5757" : "\u5DF2\u590D\u5236\u9009\u533A");
    if (this.cursorMode === "visual" || this.cursorMode === "visual-line") {
      this.cursorMode = "normal";
      this.visualAnchor = null;
      this.selStart = this.selEnd = null;
      this.selAnchor = this.selFocus = null;
    }
    return true;
  }
  #toggleSelectedBlock() {
    const item = this.blockItems[this.blockSel];
    if (!item?.foldable) return false;
    return this.#toggleAt({ nodeIdx: item.nodeIdx, blockIdx: item.blockIdx });
  }
  #openSelectedContextMenu() {
    const item = this.blockItems[this.blockSel];
    if (!item) return false;
    const info = { nodeIdx: item.nodeIdx, blockIdx: item.blockIdx };
    const node = this.nodes[item.nodeIdx];
    const entries = [{ label: "\u590D\u5236\u6D88\u606F", action: () => this.app.copyText(this.#selectedTranscriptText()) }];
    if (item.foldable) entries.push({ label: "\u5C55\u5F00 / \u6298\u53E0", action: () => this.#toggleAt(info) });
    if (node?.id) entries.push({ label: "\u8F6C\u8DF3\u8F68\u8FF9", action: () => this.app.jumpToTrajectoryNode(item.nodeIdx) });
    entries.push({ label: "\u52A0\u8F7D\u66F4\u65E9\u8BB0\u5F55", action: () => this.loadOlder() });
    this.app.openMenu(entries, { x: this.view.x + 2, y: this.view.y + Math.max(0, item.headerLine - this.view.scrollY) });
    return true;
  }
  /** Blank session: whale logo + mode selection prompt (no conversation yet). */
  #renderWelcome(screen) {
    const x = this.view.x;
    const cx = x + Math.max(0, Math.floor((this.view.w - 40) / 2));
    let y = this.view.y + 1;
    const put = (t, fg, bold) => {
      if (y < this.view.y + this.view.h) {
        screen.text(cx, y, t, { fg, attrs: bold ? 1 : 0 });
      }
      y++;
    };
    put("", 0, false);
    this.welcomeVersionRows = [];
    const versionLine = (name, version, key, fg, bold) => {
      const check = this.app.versionChecks?.[key];
      const status = check?.state === "checking" ? "\u2190 \u68C0\u67E5\u66F4\u65B0\u2026" : check?.state === "current" ? "\u2190 \u5DF2\u662F\u6700\u65B0" : check?.state === "update" ? `\u2190 \u53EF\u66F4\u65B0 ${check.latest}` : check?.state === "error" ? "\u2190 \u68C0\u67E5\u5931\u8D25\uFF08\u70B9\u51FB\u91CD\u8BD5\uFF09" : "\u2190 \u68C0\u67E5\u66F4\u65B0";
      const text = `  ${name} ${version === "unknown" ? "\u7248\u672C\u672A\u77E5" : `v${version}`}  ${status}`;
      put(text, fg, bold);
      this.welcomeVersionRows[y - 1] = { key, x1: cx, x2: cx + strWidth(text) - 1 };
    };
    versionLine("DeepSeek Harness", this.app.dshVersion ?? "unknown", "dsh", T.HEADING, true);
    versionLine("dsh-neotui", TUI_VERSION, "tui", T.FAINT, false);
    put("", 0, false);
    if (this.app.currentSession == null) {
      put("  \u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD\u5F00\u59CB\uFF0C\u6216 Ctrl+N \u65B0\u5EFA", T.DIM, false);
      return;
    }
    put("  \u8BF7\u9009\u62E9\u6A21\u5F0F\uFF08F9 \u6216\u70B9\u51FB\u4E0B\u65B9\uFF0C\u9009\u62E9\u540E\u7ACB\u5373\u751F\u6548\uFF09\uFF1A", T.WARN, true);
    put("", 0, false);
    this.welcomeModes = [];
    const currentPreset = this.app.sessions.find((s) => s.sessionId === this.app.currentSession)?.agentPreset;
    const presets = [
      ["standard", "\u6807\u51C6\u6A21\u5F0F", "\u5B8C\u6574\u7F16\u7801 Agent\uFF08\u6587\u4EF6/Shell/\u68C0\u7D22/Skills/\u76EE\u6807/\u5B50\u4EE3\u7406\uFF09"],
      ["code", "PTC \u6A21\u5F0F", "\u6807\u51C6\u6A21\u5F0F\u80FD\u529B + Code Mode SDK \u5355\u7A0B\u5E8F\u591A\u6B65\u64CD\u4F5C"],
      ["minimal", "\u6781\u7B80\u6A21\u5F0F", "\u4EC5\u6301\u4E45 bash \u4E0E str_replace_editor \u53CC\u5DE5\u5177"],
      ["cordis", "\u521B\u9020\u6A21\u5F0F", "\u6807\u51C6\u6A21\u5F0F + \u8FD0\u884C\u65F6\u68C0\u67E5/\u63D2\u4EF6\u5B9E\u9A8C/\u9884\u8BBE\u521B\u4F5C"]
    ];
    const currentIdx = presets.findIndex(([id]) => id === currentPreset);
    if (this.welcomeModeSel == null || this.welcomeModeSel >= presets.length) this.welcomeModeSel = currentIdx >= 0 ? currentIdx : 0;
    for (let i = 0; i < presets.length; i++) {
      const [id, name, desc] = presets[i];
      if (y < this.view.y + this.view.h) {
        const active = id === currentPreset;
        const cursor = this.app.focused === this && i === this.welcomeModeSel;
        const label = `${cursor ? "=>" : "  "} ${active ? "\u25CF" : "\u25CB"} ${name}${active ? " [\u5F53\u524D]" : ""}`;
        screen.text(cx, y, `  ${label}`, { fg: active ? T.OK : cursor ? T.ACCENT : T.DIM, bg: cursor ? T.MENUSEL : -1, attrs: active || cursor ? 1 : 0 });
        screen.text(cx + 2 + strWidth(label) + 1, y, truncate(desc, Math.max(1, this.view.w - strWidth(label) - 8)), { fg: cursor ? T.TXT : T.DIM, bg: cursor ? T.MENUSEL : -1 });
        this.welcomeModes[y] = id;
      }
      y++;
    }
  }
  render(screen) {
    const isBlank = this.app.sessions.find((s) => s.sessionId === this.sessionId)?.blank ?? false;
    if (this.nodes.length === 0 && isBlank) {
      this.#renderWelcome(screen);
      this.input.render(screen);
      return;
    }
    if (this.cardRanges.length) {
      const y0 = this.view.y;
      const top = this.view.scrollY;
      const bottom = this.view.scrollY + this.view.h - 1;
      for (const [a, b, bg] of this.cardRanges) {
        const va = Math.max(a, top);
        const vb = Math.min(b, bottom);
        if (vb >= va) {
          screen.fillRect(this.view.x, y0 + (va - top), this.view.x + this.view.w - 2, y0 + (vb - top), " ", { bg });
        }
      }
    }
    const selectedBlock = this.app.focused === this ? this.blockItems[this.blockSel] : null;
    let savedCodeLine = null;
    let codeCaretCol = null;
    if (selectedBlock?.kind === "code" && this.cursorMode === "normal") {
      savedCodeLine = this.lines[selectedBlock.headerLine];
      this.lines[selectedBlock.headerLine] = savedCodeLine.map((seg) => seg.copyCode ? { ...seg, t: pad("[\u6309y\u590D\u5236]", strWidth(seg.t ?? "")), fg: T.SELFG, bg: T.ACCENT } : seg);
      let col = 0;
      for (const seg of this.lines[selectedBlock.headerLine]) {
        col += strWidth(seg.t ?? "");
        if (seg.copyCode) {
          codeCaretCol = col;
          break;
        }
      }
    }
    this.view.render(screen);
    if (savedCodeLine) this.lines[selectedBlock.headerLine] = savedCodeLine;
    if (this.app.focused === this && selectedBlock) {
      if (this.cursorMode === "block") {
        const row = selectedBlock.headerLine - this.view.scrollY;
        if (row >= 0 && row < this.view.h) screen.text(this.view.x, this.view.y + row, "=>", { fg: T.SELFG, bg: T.ACCENT, attrs: 1 });
      } else {
        const caretLine = selectedBlock.kind === "code" && this.cursorMode === "normal" ? selectedBlock.headerLine : this.cursor.line;
        const row = caretLine - this.view.scrollY;
        if (row >= 0 && row < this.view.h) {
          const stops = this.#cursorStops(caretLine);
          const stop = stops[this.#cursorStopIndex(stops)];
          const codeCol = selectedBlock.kind === "code" ? Math.min(this.view.w - 2, codeCaretCol ?? 0) : this.cursor.col + (stop?.width ?? 1);
          screen.put(this.view.x + Math.max(0, Math.min(this.view.w - 2, codeCol)), this.view.y + row, "|", { fg: T.SELFG, bg: T.ACCENT, attrs: 1 });
        }
      }
    }
    this.#renderDiving(screen);
    if (this.selStart !== null && this.selEnd !== null) {
      const y0 = Math.max(this.view.scrollY, this.selStart);
      const y1 = Math.min(this.view.scrollY + this.view.h - 1, this.selEnd);
      if (y1 >= y0) {
        for (let line = y0; line <= y1; line++) {
          let x0 = this.view.x, x1 = this.view.x + this.view.w - 2;
          if (this.selAnchor && this.selFocus) {
            const a = this.selAnchor, b = this.selFocus;
            const first = a.line < b.line || a.line === b.line && a.col <= b.col ? a : b;
            const last = first === a ? b : a;
            if (line === first.line) x0 = this.view.x + first.col;
            if (line === last.line) x1 = this.view.x + Math.max(last.col, line === first.line ? first.col : 0);
          }
          screen.invertRect(x0, this.view.y + (line - this.view.scrollY), x1, this.view.y + (line - this.view.scrollY));
        }
      }
    }
    this.#renderTodos(screen);
    this.#renderAttachments(screen);
    this.input.render(screen);
    this.#renderCmdBar(screen);
  }
  #renderAttachments(screen) {
    if (!this.attachments.length) return;
    const text = this.attachments.map((a) => `${a.mediaType?.startsWith("image/") ? "\u{F02E9}" : "\u{F0214}"} ${a.name}`).join("  \xB7  ");
    const y = Math.max(this.view.y, this.input.y - 1);
    screen.fillRect(this.x, y, this.x + this.w - 1, y, " ", { bg: T.BG2 });
    screen.text(this.x + 1, y, truncate(text, Math.max(1, this.w - 25)), { fg: T.PURPLE, bg: T.BG2, bold: true });
    screen.text(Math.max(this.x + 1, this.x + this.w - 22), y, "Ctrl+O \u9644\u4EF6\u7BA1\u7406\u5668", { fg: K2.FAINT, bg: T.BG2 });
  }
  /** / command candidate bar above the input (↑/↓ cycle, Tab completes). */
  #renderCmdBar(screen) {
    const inp = this.input;
    if (!inp.cmdOpen || inp.cmds.length === 0) return;
    const n = Math.min(inp.cmds.length, 6);
    const w = Math.min(this.view.w, 44);
    const y0 = Math.max(this.view.y, inp.y - n - 1);
    screen.fillRect(this.x, y0, this.x + w - 1, y0 + n - 1, " ", { bg: T.BG2 });
    for (let i = 0; i < n; i++) {
      const c = inp.cmds[i];
      const sel = i === inp.cmdIdx;
      screen.text(this.x + 1, y0 + i, `${sel ? "\u25B8" : " "} ${c.name}`, { fg: sel ? T.SELFG : T.TXT, bg: sel ? T.MENUSEL : T.BG2, attrs: sel ? 1 : 0 });
      screen.text(this.x + 2 + strWidth(c.name) + 2, y0 + i, truncate(c.desc ?? "", w - strWidth(c.name) - 6), { fg: T.FAINT, bg: sel ? T.MENUSEL : T.BG2 });
    }
  }
  #renderDiving(screen) {
    const node = this.divingNode();
    if (!node) return;
    const elapsed = Math.max(0, (node.endedAt ?? Date.now()) - node.startedAt);
    const text = node.streaming ? ` \u25F7 Deep diving \xB7 \u5DF2\u7ECF\u8FDB\u884C ${fmtDuration(elapsed)}` : node.incomplete ? " \u25F7 Deep diving \xB7 \u4E0A\u4E00\u56DE\u5408\u8BA1\u65F6\u5DF2\u6062\u590D" : ` \u25F7 Deep diving \xB7 \u603B\u8017\u65F6 ${fmtDuration(elapsed)}`;
    const y = this.view.y + this.view.h;
    screen.fillRect(this.x, y, this.x + this.w - 1, y, " ", { bg: T.BG2 });
    screen.text(this.x, y, truncate(text, this.w), { fg: node.streaming ? T.WARN : T.DIM, bg: T.BG2, bold: node.streaming });
  }
  /** Collapsible todo block between the view and the input (Shift+T toggles). */
  #renderTodos(screen) {
    const th = this.todoHeight();
    if (th === 0) return;
    const todos = this.app.todos ?? [];
    const subagent = this.app.projections.subagent;
    const y = this.input.y - th - 1;
    screen.fillRect(this.x, y, this.x + this.w - 1, y + th - 1, " ", { bg: T.STATUSBG });
    let row = y;
    if (subagent) {
      const timing = this.app.projections.subagentTiming;
      const ms = (timing?.settledMs ?? 0) + (timing?.active ? Math.max(0, Date.now() - timing.active.since) : 0);
      screen.text(this.x, row++, ` \u25C7 \u5B50\u4EE3\u7406 \xB7 ${subagent.label ?? subagent.mode}${ms ? ` \xB7 ${fmtDuration(ms)}` : ""}`, { fg: T.PURPLE, bg: T.STATUSBG, bold: true });
    }
    if (!todos.length) return;
    const done = todos.filter((t) => t.status === "completed").length;
    const active = todos.filter((t) => t.status === "in_progress").length;
    const progress = todos.length ? ` \xB7 ${done}/${todos.length} \u5B8C\u6210${active ? ` \xB7 ${active} \u8FDB\u884C\u4E2D` : ""}` : "";
    const title = ` ${this.todosVisible ? "\u25BE" : "\u25B8"} TASKS${progress} \xB7 Shift+T ${this.todosVisible ? "\u6700\u5C0F\u5316" : "\u5C55\u5F00"} `;
    const inner = Math.max(2, this.w - 2);
    const header = truncate(title, inner - 2);
    const left = Math.max(1, inner - strWidth(header) - 1);
    screen.fillRect(this.x, row, this.x + this.w - 1, y + th - 1, " ", { bg: T.PANEL });
    screen.hline(this.x, this.x + this.w - 1, row, "\u2500", { fg: T.BORDER2, bg: T.PANEL });
    screen.put(this.x, row, "\u250C", { fg: T.BORDER2, bg: T.PANEL });
    screen.text(this.x + 1 + left, row, header, { fg: T.ACCENT, bg: T.PANEL, bold: true });
    screen.put(this.x + this.w - 1, row, "\u2510", { fg: T.BORDER2, bg: T.PANEL });
    if (!this.todosVisible) {
      screen.hline(this.x, this.x + this.w - 1, row + 1, "\u2500", { fg: T.BORDER2, bg: T.PANEL });
      screen.put(this.x, row + 1, "\u2514", { fg: T.BORDER2, bg: T.PANEL });
      screen.put(this.x + this.w - 1, row + 1, "\u2518", { fg: T.BORDER2, bg: T.PANEL });
      return;
    }
    row++;
    const bottom = y + th - 1;
    for (let i = 0; i < bottom - row; i++) {
      const t = todos[i];
      const body = t ? `${t.status === "completed" ? "\u2713" : t.status === "in_progress" ? "\u25C9" : "\u25CB"} ${t.content ?? String(t)}` : "";
      const shown = truncate(body, Math.max(1, inner - 2));
      const color = t?.status === "completed" ? T.FAINT : t?.status === "in_progress" ? T.WARN : T.DIM;
      screen.put(this.x, row + i, "\u2502", { fg: T.BORDER2, bg: T.PANEL });
      screen.text(this.x + 2, row + i, shown, { fg: color, bg: T.PANEL, bold: t?.status === "in_progress" });
      screen.put(this.x + this.w - 1, row + i, "\u2502", { fg: T.BORDER2, bg: T.PANEL });
    }
    screen.hline(this.x, this.x + this.w - 1, bottom, "\u2500", { fg: T.BORDER2, bg: T.PANEL });
    screen.put(this.x, bottom, "\u2514", { fg: T.BORDER2, bg: T.PANEL });
    screen.put(this.x + this.w - 1, bottom, "\u2518", { fg: T.BORDER2, bg: T.PANEL });
  }
  onMouse(ev) {
    if (this.input.inside(ev.x, ev.y)) {
      if (this.app.focused === this.input) return this.input.onMouse(ev);
      return true;
    }
    if (this.view.inside(ev.x, ev.y)) {
      if (this.app.focused !== this.app.chat?.input) this.app.focus(this);
      if (this.nodes.length === 0 && ev.kind === "press" && ev.button === 0) {
        const versionHit = this.welcomeVersionRows?.[ev.y];
        if (versionHit && ev.x >= versionHit.x1 && ev.x <= versionHit.x2) {
          this.app.checkUpdates(versionHit.key, true);
          return true;
        }
        const id = this.welcomeModes[ev.y];
        if (id) {
          this.app.selectPreset(id);
          return true;
        }
      }
      if (ev.kind === "wheel-up" && this.view.scrollY <= 3 && this.hasMore) {
        void this.loadOlder();
        return true;
      }
      if (ev.kind === "press" && ev.button === 0) {
        this.pressY = ev.y - this.view.y + this.view.scrollY;
        this.pressInfo = this.lineMap?.[this.pressY] ?? null;
        this.pressX = ev.x;
        this.selAnchor = { line: this.pressY, col: Math.max(0, ev.x - this.view.x) };
        this.selFocus = null;
        this.pressCtx = this.pressInfo ? this.#anchorCtx(this.pressInfo, this.pressY, ev.x) : null;
        if (process.env.DSH_TUI_DEBUG_CLICK) {
          const t = this.lines[this.pressY]?.map((g) => g.t).join("") ?? "";
          this.#clickLog(`press screenY=${ev.y} screenX=${ev.x} lineIdx=${this.pressY} mark=${JSON.stringify(this.pressInfo)} text="${t.slice(0, 40)}" scrollY=${this.view.scrollY} viewY=${this.view.y} viewH=${this.view.h} assumedH=${this.app.screen?.h} assumedW=${this.app.screen?.w} ttyRows=${process.stdout.rows} ttyCols=${process.stdout.columns} inputY=${this.input.y} inputH=${this.input.h} todoH=${this.todoHeight()} footerH=${this.app.footerHeight?.() ?? "?"}`);
        }
        return true;
      }
      if (ev.kind === "drag" && ev.button === 0 && this.pressY !== null) {
        const y = ev.y - this.view.y + this.view.scrollY;
        if (Math.abs(y - this.pressY) >= 1 || Math.abs(ev.x - (this.pressX ?? ev.x)) >= 1) {
          this.selStart = Math.min(this.pressY, y);
          this.selEnd = Math.max(this.pressY, y);
          this.selFocus = { line: y, col: Math.max(0, Math.min(this.view.w - 2, ev.x - this.view.x)) };
          this.app.redraw();
        }
        return true;
      }
      if (ev.kind === "release" && ev.button === 0 && this.pressY !== null) {
        const wasPress = this.pressY;
        this.pressY = null;
        if (this.selStart !== null && this.selEnd !== null) {
          this.pressInfo = null;
          this.pressCtx = null;
          const rows = this.selEnd - this.selStart + 1;
          let text;
          if (this.selAnchor && this.selFocus) {
            const a = this.selAnchor, b = this.selFocus;
            const first = a.line < b.line || a.line === b.line && a.col <= b.col ? a : b;
            const last = first === a ? b : a;
            const cut = (s, from, to) => {
              let out = "", col = 0;
              for (const g of graphemes(s)) {
                const next = col + graphemeWidth(g);
                if (next > from && col <= to) out += g;
                col = next;
              }
              return out;
            };
            text = this.lines.slice(first.line, last.line + 1).map((l, i, all) => {
              const s = l.map((g) => g.t).join("");
              return cut(s, i === 0 ? first.col : 0, i === all.length - 1 ? last.col : Infinity);
            }).join("\n");
          } else text = this.lines.slice(this.selStart, this.selEnd + 1).map((l) => l.map((g) => g.t).join("")).join("\n");
          this.selStart = this.selEnd = null;
          this.selAnchor = this.selFocus = null;
          this.app.copyText(text);
          this.app.toast(`\u5DF2\u590D\u5236 ${rows} \u884C`);
          return true;
        }
        this.selStart = this.selEnd = null;
        this.selAnchor = this.selFocus = null;
        this.#toggleAt(this.pressInfo, this.pressCtx);
        this.pressInfo = null;
        this.pressCtx = null;
        return true;
      }
      if (ev.kind === "press" && ev.button === 2) {
        const y = ev.y - this.view.y + this.view.scrollY;
        const info = this.lineMap?.[y];
        if (info) {
          const node = this.nodes[info.nodeIdx];
          const items = [
            { label: "\u590D\u5236\u6D88\u606F", action: () => this.app.copyNode(info.nodeIdx) }
          ];
          const clickedBlock = node?.kind === "assistant" && info.blockIdx !== null ? node.blocks[info.blockIdx] : null;
          if (clickedBlock?.kind !== "text") {
            items.push({ label: "\u5C55\u5F00 / \u6298\u53E0", action: () => this.#toggleAt(info) });
          }
          if (node?.id) {
            items.push({ label: "\u8F6C\u8DF3\u8F68\u8FF9", action: () => this.app.jumpToTrajectoryNode(info.nodeIdx) });
          }
          if (node?.kind === "assistant" && node.id) {
            const fb = this.app.feedbackMap.get(node.id);
            const cur = fb?.rating === "positive" ? " \u2713\u5DF2\u597D\u8BC4" : fb?.rating === "negative" ? " \u2713\u5DF2\u5DEE\u8BC4" : "";
            items.push({ label: "\u{1F44D} \u597D\u8BC4" + cur, action: () => this.app.feedback(node.id, "positive") });
            items.push({ label: "\u{1F44E} \u5DEE\u8BC4" + cur, action: () => this.app.feedback(node.id, "negative") });
            if (fb) items.push({ label: "\u5220\u9664\u53CD\u9988", action: () => this.app.deleteFeedback(node.id) });
          }
          items.push({ label: "\u52A0\u8F7D\u66F4\u65E9\u8BB0\u5F55", action: () => this.loadOlder() });
          this.app.openMenu(items, ev);
        }
        return true;
      }
      return this.view.onMouse(ev);
    }
    return false;
  }
  /** Match one event against the editable transcript bindings. Two-press
   *  chords arm `bindingPending`; any other key disarms it. */
  #matchChatBinding(ev) {
    if (ev.type !== "key" || this.app.focused !== this) {
      this.bindingPending = null;
      return null;
    }
    const bindings = keyBindings();
    for (const id of CHAT_BINDING_ORDER) {
      const spec = bindings[id];
      if (!spec || spec.mode === "insert") continue;
      const pending = this.bindingPending?.id === id ? this.bindingPending : null;
      const hit = matchKeyBinding(ev, spec, pending);
      if (hit?.kind === "pending") {
        this.bindingPending = { id, slot: hit.slot, part: hit.part };
        this.app.toast("\u518D\u6309\u4E00\u6B21\u5B8C\u6210\u7EC4\u5408\u952E");
        return null;
      }
      if (hit?.kind === "full") {
        this.bindingPending = null;
        return { id };
      }
    }
    this.bindingPending = null;
    return null;
  }
  onKey(ev) {
    const blankWelcome = this.nodes.length === 0 && (this.app.sessions.find((s) => s.sessionId === this.sessionId)?.blank ?? false);
    if (blankWelcome && ev.type === "key" && (ev.name === "up" || ev.name === "down")) {
      this.welcomeModeSel = wrapIndex(this.welcomeModeSel + (ev.name === "up" ? -1 : 1), this.welcomeModeIds.length);
      return true;
    }
    if (blankWelcome && ev.type === "key" && ev.name === "enter") {
      this.app.selectPreset(this.welcomeModeIds[this.welcomeModeSel]);
      return true;
    }
    if (ev.type === "text" || ev.type === "paste") {
      if (this.cursorMode !== "block") return true;
      this.app.focus(this.input);
      this.input.insert(ev.text);
      return true;
    }
    if (ev.type !== "key") return false;
    if (this.app.focused === this.input) return false;
    if (ev.ctrl && (ev.name === "up" || ev.name === "down")) {
      this.view.scroll(ev.name === "up" ? -3 : 3);
      this.app.redraw();
      return true;
    }
    if (ev.name === "up" || ev.name === "down") return this.#moveBlock(ev.name === "up" ? -1 : 1);
    if (ev.name === "pgup") {
      if (this.view.scrollY <= this.view.h) {
        void this.loadOlder();
        return true;
      }
      return this.view.scroll(-this.view.h);
    }
    if (ev.name === "pgdn") return this.view.scroll(this.view.h);
    const chatHit = this.#matchChatBinding(ev);
    if (chatHit?.id === "top") {
      this.blockSel = 0;
      const item = this.blockItems[0];
      if (item) {
        this.cursor = { line: item.headerLine, col: 0 };
        this.#scrollToTranscriptLine(item.headerLine);
      }
      return true;
    }
    if (chatHit?.id === "bottom") {
      if (this.blockItems.length === 0) return true;
      this.blockSel = this.blockItems.length - 1;
      const item = this.blockItems[this.blockSel];
      this.cursor = { line: item.headerLine, col: 0 };
      this.view.follow = false;
      this.view.anchorLock = null;
      this.view.scrollY = Math.max(0, Math.min(this.view.maxScroll(), item.headerLine - Math.max(1, this.view.h - 2)));
      this.app.redraw();
      return true;
    }
    if (chatHit?.id === "prevQuestion" || chatHit?.id === "nextQuestion") return this.#jumpQuestion(chatHit.id === "prevQuestion" ? -1 : 1);
    if (chatHit?.id === "insert") {
      this.app.focus(this.input);
      return true;
    }
    if (chatHit?.id === "sessionFilter") {
      this.app.startSearch();
      return true;
    }
    if (chatHit?.id === "think" && this.cursorMode === "block") {
      this.thinkMode = this.thinkMode === "collapsed" ? "expanded" : "collapsed";
      this.expanded.clear();
      this.collapsedBlocks.clear();
      this.app.toast(this.thinkMode === "expanded" ? "\u601D\u8003\u5757\uFF1A\u5168\u90E8\u5C55\u5F00" : "\u601D\u8003\u5757\uFF1A\u6298\u53E0\uFF08t \u5207\u6362\uFF09");
      this.queueRebuild();
      return true;
    }
    if (chatHit?.id === "tools" && this.cursorMode === "block") {
      this.bashMode = this.bashMode === "collapsed" ? "expanded" : "collapsed";
      this.expanded.clear();
      this.collapsedBlocks.clear();
      this.app.toast(this.bashMode === "collapsed" ? "\u5DE5\u5177\u5757\uFF1A\u6298\u53E0\uFF08b \u5C55\u5F00\uFF09" : "\u5DE5\u5177\u5757\uFF1A\u5C55\u5F00\uFF08b \u6298\u53E0\uFF09");
      this.queueRebuild();
      return true;
    }
    if (ev.name === "char" && ev.key === "t" && ev.shift && !ev.ctrl && !ev.alt && this.cursorMode === "block") {
      const wasPinned = this.view.follow || this.view.scrollY >= this.view.maxScroll();
      const oldMax = this.view.maxScroll();
      this.todosVisible = !this.todosVisible;
      this.app.toast(this.todosVisible ? "\u4EFB\u52A1\u5757\uFF1A\u5DF2\u5C55\u5F00\uFF08Shift+T \u6700\u5C0F\u5316\uFF09" : "\u4EFB\u52A1\u5757\uFF1A\u5DF2\u6700\u5C0F\u5316\uFF08Shift+T \u5C55\u5F00\uFF09");
      this.inputChanged();
      if (wasPinned) {
        this.view.scrollY = this.view.maxScroll();
        this.view.follow = true;
      } else this.view.scrollY = Math.max(0, Math.min(this.view.maxScroll(), this.view.scrollY + (this.view.maxScroll() - oldMax)));
      this.app.redraw();
      return true;
    }
    if (ev.name === "escape" && this.app.searchQuery) {
      this.app.searchQuery = null;
      this.queueRebuild();
      return true;
    }
    if (ev.name === "escape" && this.cursorMode !== "block") {
      this.cursorMode = "block";
      this.visualAnchor = null;
      this.#syncKeyboardSelection();
      this.app.redraw();
      return true;
    }
    if (ev.name === "escape" && this.selStart !== null) {
      this.selStart = this.selEnd = null;
      this.selAnchor = this.selFocus = null;
      this.app.redraw();
      return true;
    }
    if (ev.name === "enter" && this.blockItems[this.blockSel]) {
      this.cursorMode = "normal";
      const item = this.blockItems[this.blockSel];
      this.cursor = { line: item.headerLine, col: Math.max(0, strWidth(this.#lineText(item.headerLine)) - 1) };
      this.app.redraw();
      return true;
    }
    if (ev.name === "char" && ev.key === "j" && !ev.ctrl && !ev.alt) return this.#moveBlock(1);
    if (ev.name === "char" && ev.key === "k" && !ev.ctrl && !ev.alt) return this.#moveBlock(-1);
    if (ev.name === "char" && ev.key === "h" && !ev.ctrl && !ev.alt && this.cursorMode !== "block") {
      if (this.cursorMode === "normal" && this.blockItems[this.blockSel]?.kind === "code") return true;
      return this.#moveCursorHorizontal(-1);
    }
    if (ev.name === "char" && ev.key === "l" && !ev.ctrl && !ev.alt && this.cursorMode !== "block") {
      if (this.cursorMode === "normal" && this.blockItems[this.blockSel]?.kind === "code") return true;
      return this.#moveCursorHorizontal(1);
    }
    if (ev.name === "char" && ["w", "b", "e"].includes(ev.key) && !ev.ctrl && !ev.alt && this.cursorMode !== "block") {
      if (this.cursorMode === "normal" && this.blockItems[this.blockSel]?.kind === "code") return true;
      return this.#wordMotion(ev.key);
    }
    if (ev.name === "char" && ev.key === "0" && !ev.ctrl && !ev.alt && this.cursorMode !== "block") {
      this.cursor.col = 0;
      this.#syncKeyboardSelection();
      this.app.redraw();
      return true;
    }
    if (ev.name === "char" && ev.key === "$" && !ev.ctrl && !ev.alt && this.cursorMode !== "block") {
      const stops = this.#cursorStops();
      this.cursor.col = stops[stops.length - 1].col;
      this.#syncKeyboardSelection();
      this.app.redraw();
      return true;
    }
    if (ev.name === "char" && ev.key === "v" && !ev.ctrl && !ev.alt) {
      this.cursorMode = ev.shift ? "visual-line" : "visual";
      this.visualAnchor = { ...this.cursor };
      this.#syncKeyboardSelection();
      this.app.toast(ev.shift ? "VISUAL LINE\uFF08\u53EA\u8BFB\uFF09" : "VISUAL\uFF08\u53EA\u8BFB\uFF09");
      return true;
    }
    if (ev.name === "char" && ev.key === "y" && !ev.ctrl && !ev.alt) return this.#yankTranscript();
    if (ev.name === "char" && ev.key === "c" && ev.ctrl && ev.shift) return this.#yankTranscript();
    if (ev.name === "char" && ev.key === " " && !ev.ctrl && !ev.alt) {
      this.#toggleSelectedBlock();
      return true;
    }
    if (ev.name === "char" && ev.key === "r" && ev.ctrl) return this.#openSelectedContextMenu();
    return false;
  }
};
function toolSummary(b) {
  if (b.args) {
    try {
      const a = JSON.parse(b.args);
      if (typeof a === "object" && a !== null) {
        const desc = a.description ?? a.summary ?? a.title ?? a.query ?? a.content ?? a.name;
        if (desc) return String(desc).slice(0, 120);
        if (a.file_path) return `read ${String(a.file_path)}`.slice(0, 120);
        if (a.path && a.command) return `${a.command} ${String(a.path)}`.slice(0, 120);
        if (a.path) return String(a.path).slice(0, 120);
        return a.command ?? null;
      }
      return String(a).slice(0, 120);
    } catch {
      return String(b.args).slice(0, 120);
    }
  }
  if (b.resultView?.title) return b.resultView.title;
  if (b.view?.title) return b.view.title;
  if (b.view?.view?.title) return b.view.view.title;
  return null;
}
function fmtTokens(n) {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function truncateText(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "\n\u2026(\u622A\u65AD)" : s;
}
function wrapDisplayText(value, width) {
  const out = [];
  for (const raw of String(value ?? "").split("\n")) {
    if (!raw) {
      out.push("");
      continue;
    }
    let line = "", used = 0;
    for (const g of graphemes(raw)) {
      const gw = graphemeWidth(g);
      if (line && used + gw > width) {
        out.push(line);
        line = "";
        used = 0;
      }
      line += g;
      used += gw;
    }
    out.push(line);
  }
  return out;
}
var QuestionPopup = class extends Popup {
  constructor({ app, frame }) {
    const questions = frame.questions ?? [];
    const planReview = questions.length === 1 && questions[0]?.intent?.kind === "plan-review";
    const w = Math.max(12, Math.min(planReview ? 96 : 92, app.screen.w - 2));
    const wrapCount = (value, width) => wrapDisplayText(value, width).length;
    const estimated = questions.reduce((n, q) => n + 1 + wrapCount(q.question ?? "", w - 4) + (q.detail ? wrapCount(q.detail, w - 4) : 0) + (q.options ?? []).reduce((m, o) => m + 1 + (o.description ? wrapCount(o.description, w - 10) : 0), 0) + (q.intent?.kind === "plan-review" ? 0 : 4), 0) + 2;
    const h = Math.max(10, Math.min(app.screen.h - 2, estimated));
    super({
      x: Math.max(0, Math.floor((app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor((app.screen.h - h) / 2)),
      w,
      h,
      title: planReview ? "\u270E \u8BA1\u5212\u5BA1\u9605" : "\u2753 \u9700\u8981\u4F60\u7684\u56DE\u7B54",
      lines: ["", ...questions.map((q) => q.question ?? q.id)],
      buttons: []
    });
    this.app = app;
    this.frame = frame;
    this.questions = questions;
    this.planReview = planReview;
    this.detailScrollY = 0;
    this.detailPage = 1;
    this.optionRows = [];
    this.optionHitboxes = [];
    this.questionIdx = 0;
    this.drafts = questions.map(() => ({ selected: [], custom: "", skipped: false }));
    this.selIdx = 0;
    this.customEditing = false;
    this.customCursor = 0;
    this.onAction = (btn) => {
      if (btn.action === "__cancel__") this.#cancel();
    };
    this.#layout();
  }
  #layout() {
    const lines = [];
    for (const q of this.questions) lines.push(["", { t: q.header ?? "", fg: K2.ACCENT, bold: true }]);
    this.qLines = lines;
    this.lines = lines;
  }
  render(screen) {
    super.render(screen);
    const q = this.questions[this.questionIdx];
    if (!q) return;
    const draft = this.drafts[this.questionIdx];
    const opts = q.options ?? [];
    const optionDescriptionRows = opts.reduce((n, o) => n + (o.description ? wrapDisplayText(o.description, this.w - 10).length : 0), 0);
    const actionRows = opts.length + optionDescriptionRows + (this.planReview ? 0 : Math.min(6, Math.max(3, wrapDisplayText(draft.custom || "\u5728\u6B64\u8F93\u5165\u2026", this.w - 10).length)) + 2);
    const actionTop = Math.max(this.y + 5, this.y + this.h - 1 - Math.min(actionRows, this.h - 6));
    const doc = [
      { text: `\u258E ${q.header ?? `\u95EE\u9898 ${this.questionIdx + 1}/${this.questions.length}`}`, fg: K2.ACCENT, bold: true },
      ...wrapDisplayText(q.question ?? "", this.w - 4).map((text) => ({ text, fg: K2.TXT })),
      ...q.detail ? wrapDisplayText(q.detail, this.w - 4).map((text) => ({ text, fg: K2.DIM })) : []
    ];
    const room = Math.max(1, actionTop - (this.y + 1));
    const maxScroll = Math.max(0, doc.length - room);
    this.detailScrollY = Math.max(0, Math.min(this.detailScrollY, maxScroll));
    this.detailPage = room;
    this.detailTotal = doc.length;
    let ly = this.y + 1;
    for (const line of doc.slice(this.detailScrollY, this.detailScrollY + room)) screen.text(this.x + 2, ly++, truncate(line.text, this.w - 4), { fg: line.fg, attrs: line.bold ? 1 : 0 });
    if (maxScroll > 0) {
      screen.text(this.x + this.w - 26, this.y, `\u6B63\u6587 Ctrl+\u2191\u2193 \u7FFB\u9875 ${this.detailScrollY + 1}-${Math.min(doc.length, this.detailScrollY + room)}/${doc.length}`, { fg: K2.ACCENT, bg: T.BG2 });
    }
    screen.hline(this.x + 1, this.x + this.w - 2, actionTop - 1, "\u2500", { fg: T.BORDER2, bg: T.BG2 });
    screen.text(this.x + 3, actionTop - 1, " \u56DE\u7B54\uFF08\u2191/\u2193 \u9009\u62E9\uFF09 ", { fg: K2.ACCENT, bg: T.BG2 });
    ly = actionTop;
    this.optionRows = [];
    this.optionHitboxes = [];
    for (let i = 0; i < opts.length; i++) {
      this.optionRows[i] = ly;
      const chosen = draft.selected.includes(opts[i].label);
      const cursor = this.selIdx === i;
      const glyph = q.multiSelect ? chosen ? "\u2611" : "\u2610" : chosen ? "\u25CF" : "\u25CB";
      const optionText = truncate(` ${cursor ? "\u25B8" : " "} ${glyph} ${opts[i].label}`, this.w - 6);
      const descLines = opts[i].description ? wrapDisplayText(opts[i].description, this.w - 10) : [];
      this.optionHitboxes[i] = { x1: this.x + 2, x2: this.x + 2 + strWidth(optionText) - 1, y1: ly, y2: ly + descLines.length };
      screen.text(this.x + 2, ly++, optionText, { fg: cursor ? T.SELFG : K2.TXT, bg: cursor ? T.MENUSEL : -1 });
      for (const line of descLines) screen.text(this.x + 7, ly++, line, { fg: K2.FAINT, bg: cursor ? T.MENUSEL : -1 });
    }
    if (!this.planReview) {
      this.optionRows[opts.length] = ly;
      const cursor = this.selIdx === opts.length;
      const customText = truncate(` ${cursor ? "\u25B8" : " "} \u270E \u8F93\u5165\u81EA\u5DF1\u7684\u56DE\u7B54`, this.w - 6);
      this.optionHitboxes[opts.length] = { x1: this.x + 2, x2: this.x + 2 + strWidth(customText) - 1, y1: ly, y2: ly };
      screen.text(this.x + 2, ly++, customText, { fg: cursor ? T.SELFG : K2.ACCENT, bg: cursor ? T.MENUSEL : -1 });
      {
        const chars = Array.from(draft.custom), shown = this.customEditing ? [...chars.slice(0, this.customCursor), "\u258F", ...chars.slice(this.customCursor)].join("") : draft.custom;
        const inputLines = wrapDisplayText(shown || "\u5728\u6B64\u8F93\u5165\u2026", this.w - 10).slice(-6);
        for (let i = 0; i < inputLines.length; i++) screen.text(this.x + 4, ly++, `${i === 0 ? "> " : "  "}${inputLines[i]}`, { fg: this.customEditing ? K2.TXT : K2.FAINT, bg: this.customEditing ? T.BG2 : -1 });
      }
      {
        this.optionRows[opts.length + 1] = ly;
        const skip = this.selIdx === opts.length + 1, skipText = ` ${skip ? "\u25B8" : " "} \u21B7 \u8DF3\u8FC7\u6B64\u95EE\u9898`;
        this.optionHitboxes[opts.length + 1] = { x1: this.x + 2, x2: this.x + 2 + strWidth(skipText) - 1, y1: ly, y2: ly };
        screen.text(this.x + 2, ly++, skipText, { fg: skip ? T.SELFG : K2.FAINT, bg: skip ? T.MENUSEL : -1 });
      }
    }
  }
  #choose(i) {
    const q = this.questions[this.questionIdx];
    const option = q?.options?.[i];
    if (!option) return;
    const draft = this.drafts[this.questionIdx];
    if (q.multiSelect) {
      draft.selected = draft.selected.includes(option.label) ? draft.selected.filter((v) => v !== option.label) : [...draft.selected, option.label];
    } else {
      draft.selected = [option.label];
      draft.custom = "";
    }
  }
  onMouse(ev) {
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      const max = Math.max(0, (this.detailTotal ?? 0) - (this.detailPage ?? 1));
      this.detailScrollY = Math.max(0, Math.min(max, this.detailScrollY + (ev.kind === "wheel-up" ? -3 : 3)));
      this.app.redraw();
      return true;
    }
    if (ev.kind === "press" && ev.button === 0) {
      const q = this.questions[this.questionIdx];
      for (let i = 0; i < (q?.options?.length ?? 0); i++) {
        const box = this.optionHitboxes[i];
        if (box && ev.x >= box.x1 && ev.x <= box.x2 && ev.y >= box.y1 && ev.y <= box.y2) {
          this.selIdx = i;
          this.customEditing = false;
          this.#choose(i);
          if (!q.multiSelect) this.#continueCurrent();
          return true;
        }
      }
      const count = q?.options?.length ?? 0, customBox = this.optionHitboxes[count];
      if (customBox && ev.x >= customBox.x1 && ev.x <= customBox.x2 && ev.y === customBox.y1) {
        this.selIdx = count;
        this.customEditing = true;
        this.customCursor = Array.from(this.drafts[this.questionIdx].custom).length;
        this.drafts[this.questionIdx].selected = [];
        this.app.redraw();
        return true;
      }
      const skipBox = this.optionHitboxes[count + 1];
      if (skipBox && ev.x >= skipBox.x1 && ev.x <= skipBox.x2 && ev.y === skipBox.y1) {
        this.selIdx = count + 1;
        this.#skipCurrent();
        return true;
      }
    }
    return super.onMouse(ev);
  }
  onKey(ev) {
    const q = this.questions[this.questionIdx];
    const draft = this.drafts[this.questionIdx];
    const count = q?.options?.length ?? 0;
    const choices = count + (this.planReview ? 0 : 2);
    if (ev.type === "text") {
      if (this.customEditing || this.selIdx === count) {
        this.customEditing = true;
        draft.selected = [];
        const chars = Array.from(draft.custom);
        chars.splice(this.customCursor, 0, ...Array.from(ev.text));
        draft.custom = chars.join("");
        this.customCursor += Array.from(ev.text).length;
        draft.skipped = false;
        return true;
      }
      return false;
    }
    if (ev.type !== "key") return false;
    if (["pageup", "pagedown", "home", "end"].includes(ev.name)) {
      const total = this.detailTotal ?? 0, max = Math.max(0, total - this.detailPage);
      if (ev.name === "pageup") this.detailScrollY = Math.max(0, this.detailScrollY - this.detailPage);
      else if (ev.name === "pagedown") this.detailScrollY = Math.min(max, this.detailScrollY + this.detailPage);
      else if (ev.name === "home") this.detailScrollY = 0;
      else this.detailScrollY = max;
      this.app.redraw();
      return true;
    }
    if (!this.customEditing && ev.ctrl && ev.name === "up") {
      this.detailScrollY = Math.max(0, this.detailScrollY - this.detailPage);
      return true;
    }
    if (!this.customEditing && ev.ctrl && ev.name === "down") {
      this.detailScrollY = Math.min(Math.max(0, (this.detailTotal ?? 0) - this.detailPage), this.detailScrollY + this.detailPage);
      return true;
    }
    if (this.customEditing && ev.name === "left") {
      this.customCursor = Math.max(0, this.customCursor - 1);
      return true;
    }
    if (this.customEditing && ev.name === "right") {
      this.customCursor = Math.min(Array.from(draft.custom).length, this.customCursor + 1);
      return true;
    }
    if (this.customEditing && ev.name === "home") {
      this.customCursor = 0;
      return true;
    }
    if (this.customEditing && ev.name === "end") {
      this.customCursor = Array.from(draft.custom).length;
      return true;
    }
    if (ev.name === "up") {
      this.customEditing = false;
      this.selIdx = wrapIndex(this.selIdx - 1, choices);
      return true;
    }
    if (ev.name === "down") {
      this.customEditing = false;
      this.selIdx = wrapIndex(this.selIdx + 1, choices);
      return true;
    }
    if (ev.name === "char" && ev.key === " " && count && this.selIdx < count) {
      this.#choose(this.selIdx);
      return true;
    }
    if (ev.name === "backspace" && this.customEditing && this.customCursor > 0) {
      const chars = Array.from(draft.custom);
      chars.splice(this.customCursor - 1, 1);
      draft.custom = chars.join("");
      this.customCursor--;
      return true;
    }
    if (ev.name === "delete" && this.customEditing) {
      const chars = Array.from(draft.custom);
      if (this.customCursor < chars.length) {
        chars.splice(this.customCursor, 1);
        draft.custom = chars.join("");
      }
      return true;
    }
    if (ev.name === "enter") {
      if (!this.planReview && this.selIdx === count + 1) {
        this.#skipCurrent();
        return true;
      }
      if (!this.planReview && this.selIdx === count && !this.customEditing) {
        this.customEditing = true;
        this.customCursor = Array.from(draft.custom).length;
        draft.selected = [];
        return true;
      }
      if (this.customEditing) {
        if (!draft.custom.trim()) {
          this.app.toast("\u8BF7\u8F93\u5165\u81EA\u5DF1\u7684\u56DE\u7B54");
          return true;
        }
        this.#continueCurrent();
        return true;
      }
      if (count && draft.selected.length === 0 && !draft.custom) this.#choose(this.selIdx);
      this.#continueCurrent();
      return true;
    }
    if (ev.name === "escape") {
      this.#cancel();
      return true;
    }
    return super.onKey(ev);
  }
  #skipCurrent() {
    this.drafts[this.questionIdx] = { selected: [], custom: "", skipped: true };
    this.#advanceOrSubmit();
  }
  #continueCurrent() {
    const d = this.drafts[this.questionIdx];
    if (!d.skipped && d.selected.length === 0 && !d.custom.trim()) {
      this.app.toast("\u8BF7\u5148\u9009\u62E9\u6216\u8F93\u5165\u7B54\u6848\uFF0C\u4E5F\u53EF\u9009\u62E9\u8DF3\u8FC7");
      return;
    }
    this.#advanceOrSubmit();
  }
  #advanceOrSubmit() {
    if (this.questionIdx < this.questions.length - 1) {
      this.questionIdx++;
      this.selIdx = 0;
      this.customEditing = false;
      this.customCursor = 0;
      this.detailScrollY = 0;
      this.#layout();
      this.app.redraw();
      return;
    }
    this.#submit();
  }
  #cancel() {
    this.app.api.cancelResponse(this.frame.rpcId).catch((e) => this.app.toast(`\u53D6\u6D88\u5931\u8D25: ${e.message}`));
    if (typeof this.app.finishPrompt === "function") this.app.finishPrompt();
    else this.app.closePopup();
  }
  #submit() {
    const answers = this.questions.map((q, i) => {
      const d = this.drafts[i];
      const custom = d.custom.trim();
      return { id: q.id, selected: custom && !q.multiSelect ? [] : d.selected, ...custom ? { custom } : {} };
    });
    this.app.api.respond(this.frame.rpcId, { sessionId: this.frame.sessionId, answer: { answers } }).catch((e) => this.app.toast(`\u56DE\u7B54\u5931\u8D25: ${e.message}`));
    if (typeof this.app.finishPrompt === "function") this.app.finishPrompt();
    else this.app.closePopup();
  }
};
var ApprovalPopup = class extends Popup {
  constructor({ app, frame }) {
    const maxW = Math.max(12, app.screen.w - 2);
    const w = Math.min(72, maxW);
    const command = app.chat?.toolCommandForCall?.(frame.callId) ?? null;
    const wrap = (value, width) => {
      const out = [];
      for (const raw of String(value ?? "").split("\n")) {
        const gs = graphemes(raw);
        let line = "", used = 0;
        for (const g of gs) {
          const gw = graphemeWidth(g);
          if (used + gw > width && line) {
            out.push(line);
            line = "";
            used = 0;
          }
          line += g;
          used += gw;
        }
        out.push(line);
      }
      return out;
    };
    const reason = frame.reason ?? `\u5DE5\u5177 ${frame.toolName ?? "tool"} \u8BF7\u6C42\u8D8A\u6743\u6267\u884C`;
    const lines = [[{ t: " \u8BF7\u6C42\u539F\u56E0", fg: K2.DIM, underline: true }], ...wrap(reason, w - 6).map((line) => [{ t: `  ${line}`, fg: K2.WARN }])];
    if (command) lines.push([{ t: " \u5C06\u6267\u884C", fg: K2.DIM, underline: true }], ...wrap(command, w - 6).map((line) => [{ t: "  " + line, fg: K2.TXT }]));
    lines.push([{ t: " \u5BFC\u822A\uFF1A\u2191/\u2193 \u9010\u884C \xB7 PgUp/PgDn \u7FFB\u9875 \xB7 \u6EDA\u8F6E \xB7 \u2190/\u2192 \u9009\u62E9", fg: K2.FAINT }]);
    super({
      x: Math.max(0, Math.floor((app.screen.w - w) / 2)),
      y: Math.max(0, Math.floor((app.screen.h - Math.min(app.screen.h - 2, Math.max(10, Math.min(24, lines.length + 4)))) / 2)),
      w,
      h: Math.min(app.screen.h - 2, Math.max(10, Math.min(24, lines.length + 4))),
      title: "\u26A0 \u5DE5\u5177\u9700\u8981\u6388\u6743 \xB7 \u53EF\u6EDA\u52A8",
      lines,
      buttons: [
        { label: "\u5141\u8BB8\u4E00\u6B21", action: "allowed-once" },
        { label: "\u62D2\u7EDD", action: "rejected" }
      ],
      scrollable: true
    });
    this.app = app;
    this.frame = frame;
    this.btnIdx = 1;
    this.onAction = (btn) => this.#answer(btn);
  }
  #answer(btn) {
    if (btn.action === "__cancel__") btn = this.buttons[1];
    const value = { sessionId: this.frame.sessionId, approvalId: this.frame.approvalId, outcome: btn.action };
    this.app.api.respond(this.frame.rpcId, value).catch((e) => this.app.toast(`\u5BA1\u6279\u5931\u8D25: ${e.message}`));
    if (typeof this.app.finishPrompt === "function") this.app.finishPrompt();
    else this.app.closePopup();
  }
  onKey(ev) {
    if (ev.type !== "key") return false;
    if (ev.name === "char" && (ev.key === "y" || ev.key === "Y") && !ev.ctrl && !ev.alt) {
      this.#answer(this.buttons[0]);
      return true;
    }
    if (ev.name === "char" && (ev.key === "n" || ev.key === "N") && !ev.ctrl && !ev.alt) {
      this.#answer(this.buttons[1]);
      return true;
    }
    return super.onKey(ev);
  }
};
var App = class {
  constructor({ screen, term, api, base, log: log2, versionFetcher = latestNpmVersion, cache: cache2 = null }) {
    this.screen = screen;
    this.term = term;
    this.api = api;
    this.cache = cache2 ?? new CacheRepository();
    this.log = log2 ?? (() => {
    });
    this.versionFetcher = versionFetcher;
    this.popup = null;
    this.activePrompt = null;
    this.promptQueue = [];
    this.menu = null;
    this.toastMsg = null;
    this.toastUntil = 0;
    this.jobs = [];
    this.jobsBySession = /* @__PURE__ */ new Map();
    this.subagentStatsBySession = /* @__PURE__ */ new Map();
    this.projectionsBySession = /* @__PURE__ */ new Map();
    this.queueBySession = /* @__PURE__ */ new Map();
    this.ctrlCUntil = null;
    this.lastSec = 0;
    this.focused = null;
    this.provider = "";
    this.model = "";
    this.currentModel = null;
    this.sessionEpoch = 0;
    this.refreshSessionsSeq = 0;
    this.searchSeq = 0;
    this.connState = "connecting";
    this.tokenUsage = null;
    this.sessions = [];
    this.currentSession = null;
    this.dshVersion = installedDshVersion();
    this.versionChecks = {
      dsh: { state: "idle", latest: null },
      tui: { state: "idle", latest: null }
    };
    this.searchActive = false;
    this.overlay = null;
    this.fullBuffer = null;
    this.mode = "chat";
    this.sidebarWanted = true;
    this.sidebarVisible = true;
    this.tooSmall = false;
    this.sidebarWidth = 30;
    this.draggingDivider = false;
    this.inputDrag = false;
    this.feedbackMap = /* @__PURE__ */ new Map();
    this.searchQuery = null;
    this.queueItems = [];
    this.findQuery = null;
    this.projections = {};
    this.workspacePanel = null;
    this.trajectoryPanel = null;
    this.settingsPanel = null;
    this.modelPanel = null;
    this.subagentPanel = null;
    this.skillsPanel = null;
    this.sidebar = new SidebarTree(this);
    this.sidebar.w = this.sidebarWidth;
    this.sidebar.h = screen.h - 1;
    this.searchInput = new Input({ x: 0, y: 0, w: this.sidebarWidth, h: 1, prompt: "/ ", placeholder: "\u8F93\u5165\u8DE8\u4F1A\u8BDD\u5168\u6587\u67E5\u8BE2\uFF0CEnter \u6267\u884C\u2026" });
    this.searchState = null;
    this.chat = new ChatView({ x: this.sidebarWidth, y: 0, w: screen.w - this.sidebarWidth, h: screen.h - 1, app: this });
    this.status = new StatusBar({ x: 0, y: screen.h - 1, w: screen.w, h: 1 });
    this.focus(this.chat);
    this.layout();
  }
  footerHeight() {
    return 3;
  }
  layout() {
    this.tooSmall = this.screen.w < 20 || this.screen.h < 6;
    this.sidebarVisible = this.sidebarWanted && this.screen.w >= 50;
    if (this.sidebarVisible) this.sidebarWidth = Math.max(14, Math.min(this.sidebarWidth, this.screen.w - 20));
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const w = Math.max(1, this.screen.w - x);
    const footerH = Math.min(this.footerHeight(), Math.max(1, this.screen.h - 2));
    const mainH = Math.max(1, this.screen.h - 1 - footerH);
    this.sidebar.x = 0;
    this.sidebar.y = 0;
    this.sidebar.w = this.sidebarWidth;
    this.sidebar.h = this.screen.h - 1;
    this.searchInput.w = this.sidebarWidth;
    this.chat.resize(x, 1, w, mainH);
    if (this.trajectoryPanel?.relayout) this.trajectoryPanel.relayout(x, 1, w, mainH);
    if (this.fullBuffer?.relayout) this.fullBuffer.relayout(0, 0, this.screen.w, this.screen.h);
    this.status.y = this.screen.h - footerH;
    this.status.h = footerH;
    this.status.w = this.screen.w;
  }
  resize(w, h) {
    this.screen.resize(w, h);
    this.layout();
    this.redraw();
  }
  toggleChatTrajectory() {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    this.setMode(this.mode === "trajectory" ? "chat" : "trajectory");
  }
  /** tmux-style pane focus. The sequence wraps and skips unavailable panes. */
  focusPane(delta) {
    const panes = [];
    if (this.sidebarVisible) panes.push("sidebar");
    panes.push("chat");
    if (this.currentSession) panes.push("trajectory");
    const current2 = this.focused === this.sidebar ? "sidebar" : this.mode === "trajectory" ? "trajectory" : "chat";
    const next = panes[wrapIndex(Math.max(0, panes.indexOf(current2)) + delta, panes.length)];
    if (next === "sidebar") {
      this.focus(this.sidebar);
    } else if (next === "trajectory") {
      this.setMode("trajectory");
      this.focus(this.trajectoryPanel ?? this.chat);
    } else {
      this.setMode("chat");
      this.focus(this.chat);
    }
    this.redraw();
    return true;
  }
  async checkUpdates(target = null, notify = false) {
    const specs = {
      dsh: { package: "@deepseek-ai/dsh", current: this.dshVersion, label: "DeepSeek Harness" },
      tui: { package: "dsh-neotui", current: TUI_VERSION, label: "dsh-neotui" }
    };
    const keys = target ? [target] : Object.keys(specs);
    await Promise.all(keys.map(async (key) => {
      const spec = specs[key];
      if (!spec) return;
      this.versionChecks[key] = { state: "checking", latest: null };
      this.redraw();
      try {
        const latest = await this.versionFetcher(spec.package);
        const comparison = compareSemver(spec.current, latest);
        const state = comparison === null ? latest === spec.current ? "current" : "update" : comparison < 0 ? "update" : "current";
        this.versionChecks[key] = { state, latest };
        if (notify) this.toast(state === "current" ? `${spec.label} \u5DF2\u662F\u6700\u65B0\u7248\u672C ${spec.current}` : `${spec.label} \u53EF\u66F4\u65B0: ${spec.current} \u2192 ${latest}`);
      } catch (error) {
        this.versionChecks[key] = { state: "error", latest: null };
        if (notify) this.toast(`${spec.label} \u66F4\u65B0\u68C0\u67E5\u5931\u8D25: ${error.message}`);
      }
      this.redraw();
    }));
  }
  /** Chat → trajectory: open the trajectory panel at the step containing a
   *  chat node (right-click menu), loading older steps on demand. */
  async jumpToTrajectoryNode(nodeIdx) {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    const node = this.chat.nodes[nodeIdx];
    if (!node) {
      this.toast("\u6D88\u606F\u4E0D\u5B58\u5728");
      return;
    }
    if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
    this.setMode("trajectory");
    await this.trajectoryPanel.focusMessage(node.id ?? null);
  }
  /** Trajectory → chat: switch back to the chat view scrolled at the message
   *  the step belongs to (right-click menu). */
  jumpToChatStep(si) {
    const step = this.trajectoryPanel?.steps?.[si];
    if (!step) {
      this.toast("\u8BE5\u6B65\u9AA4\u4E0D\u53EF\u7528");
      return;
    }
    let messageId = null;
    for (const e of step.events) {
      const d = e.data ?? {};
      const id = d.id ?? d.message?.id;
      if (id) {
        messageId = id;
        break;
      }
    }
    if (!messageId) {
      this.toast("\u8BE5\u6B65\u9AA4\u6CA1\u6709\u5173\u8054\u6D88\u606F ID");
      return;
    }
    this.setMode("chat");
    const idx = this.chat.nodes.findIndex((n) => n.id === messageId);
    if (idx >= 0 && this.chat.jumpToNode(idx)) {
      this.toast(`\u5DF2\u8F6C\u8DF3\u5230\u6D88\u606F ${messageId.slice(0, 8)}`);
    } else {
      this.toast(idx >= 0 ? "\u8BE5\u6D88\u606F\u5728\u66F4\u65E9\u7684\u8BB0\u5F55\u4E2D\uFF08PgUp \u52A0\u8F7D\u540E\u518D\u8BD5\uFF09" : "\u5BF9\u5E94\u6D88\u606F\u4E0D\u5728\u5DF2\u52A0\u8F7D\u7684\u5BF9\u8BDD\u7A97\u53E3");
    }
  }
  toggleSidebar() {
    this.sidebarWanted = !this.sidebarWanted;
    this.layout();
    this.toast(this.sidebarVisible ? "\u4FA7\u680F\u663E\u793A\uFF08Ctrl+B \u9690\u85CF\uFF09" : this.sidebarWanted ? "\u7EC8\u7AEF\u8F83\u7A84\uFF0C\u4FA7\u680F\u5DF2\u81EA\u52A8\u9690\u85CF" : "\u4FA7\u680F\u9690\u85CF\uFF08Ctrl+B \u6062\u590D\uFF09");
    if (this.sidebarVisible) this.focus(this.sidebar);
    else this.focus(this.chat);
    this.redraw();
  }
  focus(w) {
    this.focused = w;
    if (this.sidebar) this.sidebar.focused = w === this.sidebar;
    if (this.chat?.input) this.chat.inputActive = w === this.chat.input;
  }
  openMenu(items, ev) {
    const w = Math.max(16, Math.min(40, ...items.map((i) => strWidth(i.label) + 6)));
    const h = items.length + 2;
    const x = Math.max(0, Math.min(ev.x, this.screen.w - w));
    const y = Math.max(0, Math.min(ev.y, this.screen.h - h - 1));
    this.menu = new Menu({ x, y, w, h, items, onAction: (it) => {
      this.menu = null;
      if (it) it.action?.();
      this.redraw();
    } });
    this.redraw();
  }
  closePopup() {
    this.popup = null;
    this.redraw();
  }
  #promptKey(type, frame) {
    return `${type}:${frame.__rpcId ?? frame.rpcId ?? frame.approvalId ?? frame.questions?.map((q) => q.id).join("|") ?? frame.sessionId}`;
  }
  #enqueuePrompt(type, frame) {
    const key = this.#promptKey(type, frame);
    if (this.activePrompt?.key === key || this.promptQueue.some((p) => p.key === key)) return;
    this.promptQueue.push({ type, frame, key });
    this.#showNextPrompt();
  }
  #showNextPrompt() {
    if (this.activePrompt || this.popup) return;
    const next = this.promptQueue.shift();
    if (!next) return;
    this.activePrompt = next;
    const frame = { ...next.frame, rpcId: next.frame.__rpcId ?? next.frame.rpcId };
    this.popup = next.type === "approval/requested" ? new ApprovalPopup({ app: this, frame }) : new QuestionPopup({ app: this, frame });
    this.redraw();
  }
  finishPrompt() {
    this.activePrompt = null;
    this.popup = null;
    this.#showNextPrompt();
    this.redraw();
  }
  #dismissPrompt(frame) {
    const rpcId = frame.questionRpcId ?? frame.__rpcId ?? frame.rpcId;
    const approvalId = frame.approvalId;
    const match = (p) => rpcId && (p.frame.__rpcId ?? p.frame.rpcId) === rpcId || approvalId && p.frame.approvalId === approvalId;
    if (this.activePrompt && match(this.activePrompt)) {
      this.activePrompt = null;
      this.popup = null;
    }
    this.promptQueue = this.promptQueue.filter((p) => !match(p));
    this.#showNextPrompt();
  }
  toast(msg) {
    this.toastMsg = msg;
    this.toastUntil = Date.now() + 3e3;
    this.redraw();
  }
  setStatus(msg) {
    this.statusMsg = msg;
    this.redraw();
  }
  setJobs(jobs, sessionId = null) {
    if (sessionId != null) this.jobsBySession.set(sessionId, jobs);
    if (sessionId == null || sessionId === this.currentSession) this.jobs = jobs;
    this.layout();
    this.redraw();
  }
  #startPolling() {
    let ticks = 0;
    const tick = () => {
      if (this.chat.sessionId) this.chat.pollTail();
      if (ticks++ % 10 === 0) {
        this.refreshSessions();
        this.refreshSubagentStats();
      }
      const delay = this.chat.pollSlow ? 2e3 : this.chat.running ? 500 : 1500;
      this.pollTimer = setTimeout(tick, delay);
    };
    this.pollTimer = setTimeout(tick, 500);
  }
  async init() {
    this.api.onAuthRequired = () => {
      this.stop(false);
      this.onAuthRequired?.();
    };
    try {
      const host = await this.api.call("host.describe");
      this.provider = host.provider ?? "";
      this.model = host.model ?? "";
    } catch (e) {
      this.log(`[app] host.describe: ${e.message}`);
    }
    if (!this.api.auth.authenticated) return false;
    void this.checkUpdates();
    await this.refreshSessions();
    if (!this.api.auth.authenticated) return false;
    const resumeId = process.env.DSH_TUI_RESUME_SESSION;
    if (resumeId && this.sessions.some((s) => s.sessionId === resumeId)) {
      await this.openSession(resumeId);
      const scroll = Number(process.env.DSH_TUI_RESUME_SCROLL);
      if (Number.isFinite(scroll)) {
        this.chat.view.follow = process.env.DSH_TUI_RESUME_FOLLOW === "1";
        this.chat.view.scrollY = this.chat.view.follow ? this.chat.view.maxScroll() : Math.max(0, Math.min(this.chat.view.maxScroll(), scroll));
      }
    } else if (!this.currentSession) {
      await this.newSessionIn(null);
    }
    this.api.connectMux();
    this.api.connectHost();
    this.api.onFrame = (frame) => this.#onFrame(frame);
    this.api.onHostFrame = (frame) => this.#onHostFrame(frame);
    this.api.onStateChange = (s) => {
      this.connState = s;
      this.redraw();
    };
    this.#startPolling();
    if (this.term?.kitty && !this.term?.kittyActive) {
      setTimeout(() => {
        if (!this.term?.kittyActive) {
          this.toast("\u7EC8\u7AEF\u672A\u5F00\u542F kitty \u952E\u76D8\u534F\u8BAE\uFF1AShift+Enter \u6362\u884C\u4E0D\u53EF\u7528\uFF08\u53EF\u7528 Ctrl+J\uFF09\u3002WezTerm \u8BF7\u5728\u914D\u7F6E\u4E2D\u8BBE\u7F6E enable_kitty_keyboard = true \u540E\u91CD\u542F\u7EC8\u7AEF");
        }
      }, 1500);
    }
    return true;
  }
  async refreshSessions() {
    const seq = ++this.refreshSessionsSeq;
    try {
      const [list, workspaces] = await Promise.all([
        this.api.call("session.list"),
        this.api.call("workspace.list").catch(() => ({ items: [], archivedSessionIds: [] }))
      ]);
      if (seq !== this.refreshSessionsSeq) return;
      this.sessions = [...list.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      this.workspaceItems = workspaces.items ?? [];
      this.archivedSessionIds = workspaces.archivedSessionIds ?? [];
      this.sidebar.setData(this.workspaceItems, this.sessions, this.archivedSessionIds, this.currentSession);
      this.redraw();
    } catch (e) {
      this.toast(`\u4F1A\u8BDD\u5217\u8868\u52A0\u8F7D\u5931\u8D25: ${e.message}`);
    }
  }
  #onFrame(frame) {
    this.injectFrame(frame);
  }
  /** Public entry for frame injection (scripted tests, future RPC). */
  injectFrame(frame) {
    switch (frame.type) {
      case "question/requested":
      case "approval/requested": {
        this.#enqueuePrompt(frame.type, frame);
        break;
      }
      case "session/event":
      case "session/title":
      case "session/subscribed":
      case "session/queue":
        if (frame.type === "session/queue" && frame.sessionId) this.queueBySession.set(frame.sessionId, frame.items ?? []);
        if (this.chat.sessionId === frame.sessionId) {
          if (frame.type === "session/queue") {
            this.queueItems = frame.items ?? [];
            if (this.overlay instanceof QueuePanel) this.overlay.syncItems(this.queueItems);
          }
          this.chat.onFrame(frame);
        }
        if (frame.type === "session/title") this.refreshSessions();
        break;
      case "session/jobs":
        this.setJobs(frame.jobs ?? [], frame.sessionId ?? null);
        if (this.chat.sessionId === frame.sessionId) this.chat.onFrame(frame);
        break;
      case "session/projection": {
        if (frame.sessionId) {
          const cached = { ...this.projectionsBySession.get(frame.sessionId) ?? {} };
          cached[frame.key] = frame.value;
          this.projectionsBySession.set(frame.sessionId, cached);
          this.cache.put("projections", frame.sessionId, cached);
        }
        if (frame.sessionId && frame.sessionId !== this.currentSession) break;
        this.projections[frame.key] = frame.value;
        if (frame.key === "tokenUsage") this.tokenUsage = frame.value;
        if (["todos", "goal", "subagent"].includes(frame.key)) this.chat.inputChanged();
        if (["todos", "goal"].includes(frame.key) && this.overlay instanceof GoalPanel) this.overlay.sync();
        break;
      }
      case "approval/resolved":
      case "question/resolved":
        this.#dismissPrompt(frame);
        this.log(`[frame] ${frame.type}`);
        break;
      case "stream/error":
        this.log(`[frame] ${frame.type}`);
        this.toast(`\u5B9E\u65F6\u6D41\u9519\u8BEF: ${frame.message ?? frame.error?.message ?? "\u672A\u77E5\u9519\u8BEF"}`);
        break;
      default:
        this.log(`[frame] unknown: ${frame.type}`);
    }
    this.redraw();
  }
  #onHostFrame(frame) {
    if (frame.type === "host/session-added" || frame.type === "host/session-removed") {
      this.refreshSessions();
    } else if (frame.type === "host/session-status") {
      const session = this.sessions.find((s) => s.sessionId === frame.sessionId);
      if (session) session.running = frame.running;
      if (frame.sessionId === this.currentSession) this.chat.running = frame.running || this.chat.nodes.some((n) => n.kind === "turn-progress" && n.streaming);
      this.sidebar.setData(this.workspaceItems ?? [], this.sessions, [], this.currentSession);
    }
    this.redraw();
  }
  sessionMenu(item, ev) {
    const s = item.data;
    this.openMenu([
      { label: "\u6253\u5F00", action: () => this.openSession(s.sessionId) },
      { label: "\u91CD\u547D\u540D", action: () => this.renameSession(s) },
      { label: "\u4E0A\u79FB", action: () => this.moveSession(s, -1) },
      { label: "\u4E0B\u79FB", action: () => this.moveSession(s, 1) },
      { label: s.running ? "\u505C\u6B62\u8FD0\u884C" : "\u7EE7\u7EED\u5BF9\u8BDD", action: () => s.running ? this.cancelSession(s) : this.openSession(s.sessionId) },
      { label: "\u590D\u5236\u4F1A\u8BDD ID", action: () => this.copyText(s.sessionId) },
      { label: "\u5206\u53C9\u4F1A\u8BDD", action: () => this.forkSession(s) },
      { label: "\u5BFC\u51FA\u903B\u8F91\u4F1A\u8BDD (JSON)", action: () => this.exportSession(s) },
      ,
      { label: "\u5F52\u6863\u4F1A\u8BDD\u2026", action: () => this.archiveSession(s) },
      { label: "\u65B0\u5EFA\u4F1A\u8BDD", action: () => this.newSession() }
    ], ev);
  }
  /** Move a session up/down within its workspace (durable display order). */
  async moveSession(sess, delta) {
    const ws = this.workspaceItems?.find((w) => (w.sessionIds ?? []).includes(sess.sessionId));
    if (!ws) {
      this.toast("\u8BE5\u4F1A\u8BDD\u4E0D\u5728\u5DE5\u4F5C\u533A\u5185");
      return;
    }
    const ids = ws.sessionIds;
    const idx = ids.indexOf(sess.sessionId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    const beforeSessionId = delta === -1 ? ids[target] : target + 1 < ids.length ? ids[target + 1] : void 0;
    try {
      await this.api.call("workspace.insertSessionBefore", {
        workspaceId: ws.workspaceId,
        sessionId: sess.sessionId,
        ...beforeSessionId !== void 0 ? { beforeSessionId } : {}
      });
      await this.refreshSessions();
    } catch (e) {
      this.toast(`\u79FB\u52A8\u5931\u8D25: ${e.message}`);
    }
  }
  /** Move a workspace up/down in the durable display order. */
  async moveWorkspace(node, delta) {
    const ws = this.workspaceItems?.find((w) => w.workspaceId === node.workspaceId);
    if (!ws || !this.workspaceItems) {
      this.toast("\u627E\u4E0D\u5230\u5DE5\u4F5C\u533A");
      return;
    }
    const ids = this.workspaceItems.map((w) => w.workspaceId);
    const idx = ids.indexOf(ws.workspaceId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= ids.length) return;
    const beforeWorkspaceId = delta === -1 ? ids[target] : target + 1 < ids.length ? ids[target + 1] : void 0;
    try {
      await this.api.call("workspace.insertBefore", {
        workspaceId: ws.workspaceId,
        ...beforeWorkspaceId !== void 0 ? { beforeWorkspaceId } : {}
      });
      await this.refreshSessions();
    } catch (e) {
      this.toast(`\u79FB\u52A8\u5DE5\u4F5C\u533A\u5931\u8D25: ${e.message}`);
    }
  }
  /** Yazi-style folder picker → workspace.create. */
  addWorkspace() {
    const defaultPath = process.env.DSH_TUI_WORKSPACE ?? "/home/ubuntu/workspaces/default";
    const input = new Input({
      x: 4,
      y: Math.max(3, Math.floor(this.screen.h / 2)),
      w: Math.max(20, this.screen.w - 8),
      h: 1,
      prompt: "\u8FDC\u7A0B\u8DEF\u5F84: ",
      allowEmptyEnter: true,
      onEnter: async (value) => {
        const path = value.trim();
        if (!path.startsWith("/")) {
          this.toast("\u5DE5\u4F5C\u533A\u5FC5\u987B\u662F\u8FDC\u7A0B Linux \u4E3B\u673A\u4E0A\u7684\u7EDD\u5BF9\u8DEF\u5F84");
          return;
        }
        try {
          await this.api.call("workspace.create", { path });
          this.popup = null;
          this.renameInput = null;
          this.focus(this.chat);
          await this.refreshSessions();
          this.toast(`\u5DF2\u6DFB\u52A0\u5DE5\u4F5C\u533A: ${path}`);
        } catch (e) {
          this.toast(`\u6DFB\u52A0\u5931\u8D25: ${e.message}`);
        }
      }
    });
    input.setValue(defaultPath, { select: true });
    this.renameInput = input;
    this.popup = new Popup({
      x: 2,
      y: Math.max(1, Math.floor(this.screen.h / 2) - 2),
      w: Math.max(24, this.screen.w - 4),
      h: 5,
      title: "\u6DFB\u52A0\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
      lines: [[{ t: " \u8DEF\u5F84\u7531 Linux \u7F51\u5173\u4E3B\u673A\u89E3\u6790\uFF1B\u4E0D\u4F1A\u6D4F\u89C8\u6216\u4E0A\u4F20\u672C\u673A\u76EE\u5F55\u3002", fg: T.FAINT }]],
      buttons: []
    });
    this.focus(input);
    this.redraw();
  }
  renameSession(s) {
    this.closeOverlay();
    const input = new Input({ x: 2, y: this.screen.h - 3, w: this.screen.w - 4, h: 1, prompt: "\u6807\u9898: ", allowEmptyEnter: true, onEnter: () => this.#commitRename(s, input) });
    input.setValue(s.projections?.values?.title ?? "", { select: true });
    this.renameInput = input;
    this.popup = new Popup({
      x: 1,
      y: this.screen.h - 4,
      w: this.screen.w - 2,
      h: 3,
      title: "\u91CD\u547D\u540D\u4F1A\u8BDD",
      lines: [],
      buttons: [{ label: "\u4FDD\u5B58", action: "save" }, { label: "\u53D6\u6D88", action: "cancel" }],
      onAction: (btn) => {
        if (btn.action === "save") this.#commitRename(s, input);
        else this.#closeRename();
      }
    });
    this.focus(input);
    this.redraw();
  }
  #commitRename(s, input) {
    const title = input.value.trim();
    if (title === "") {
      this.toast("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
      return;
    }
    this.api.call("session.rename", { sessionId: s.sessionId, title }).then(() => {
      this.#closeRename();
      this.refreshSessions();
    }).catch((e) => this.toast(`\u91CD\u547D\u540D\u5931\u8D25: ${e.message}`));
  }
  #closeRename() {
    this.popup = null;
    this.renameInput = null;
    this.focus(this.chat);
    this.redraw();
  }
  archiveSession(session) {
    this.closeOverlay();
    const popup = new Popup({ x: Math.max(1, Math.floor(this.screen.w / 2) - 30), y: Math.max(1, Math.floor(this.screen.h / 2) - 3), w: Math.min(60, this.screen.w - 2), h: 7, title: "\u5F52\u6863\u4F1A\u8BDD", lines: [[{ t: " \u4F1A\u8BDD\u5C06\u4ECE\u5DE5\u4F5C\u533A\u548C\u672A\u5206\u7EC4\u5217\u8868\u9690\u85CF\uFF1B\u65E5\u5FD7\u4E0D\u4F1A\u5220\u9664\u3002", fg: T.TXT }]], buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u786E\u8BA4\u5F52\u6863", action: "archive" }], onAction: (btn) => {
      if (btn.action !== "archive") {
        this.closeOverlay();
        return;
      }
      this.api.call("workspace.archiveSession", { sessionId: session.sessionId }).then(() => {
        this.closeOverlay();
        this.toast("\u4F1A\u8BDD\u5DF2\u5F52\u6863");
        this.refreshSessions();
      }).catch((e) => this.toast(`\u5F52\u6863\u5931\u8D25: ${e.message}`));
    } });
    this.overlay = popup;
    this.focus(popup);
    this.redraw();
  }
  deleteWorkspace(group) {
    this.closeOverlay();
    const popup = new Popup({
      x: Math.max(1, Math.floor(this.screen.w / 2) - 34),
      y: Math.max(1, Math.floor(this.screen.h / 2) - 4),
      w: Math.min(68, this.screen.w - 2),
      h: 8,
      title: "\u5220\u9664\u5DE5\u4F5C\u533A\u6CE8\u518C",
      lines: [
        [{ t: ` \u5220\u9664\u201C${truncate(group.title, 42)}\u201D\uFF1F`, fg: T.WARN, bold: true }],
        [{ t: " \u4EC5\u79FB\u9664 TUI/WebUI \u4E2D\u7684\u5DE5\u4F5C\u533A\u6CE8\u518C\u3002", fg: T.TXT }],
        [{ t: " \u76EE\u5F55\u3001\u7528\u6237\u6587\u4EF6\u548C\u4F1A\u8BDD\u65E5\u5FD7\u4E0D\u4F1A\u5220\u9664\uFF1B\u4F1A\u8BDD\u5C06\u8FDB\u5165\u201C\u672A\u5206\u7EC4\u201D\u3002", fg: T.FAINT }]
      ],
      buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u786E\u8BA4\u5220\u9664", action: "delete" }],
      onAction: (btn) => {
        if (btn.action !== "delete") {
          this.closeOverlay();
          return;
        }
        this.api.call("workspace.delete", { workspaceId: group.workspaceId }).then(() => {
          this.closeOverlay();
          this.toast("\u5DE5\u4F5C\u533A\u6CE8\u518C\u5DF2\u5220\u9664\uFF0C\u6587\u4EF6\u548C\u4F1A\u8BDD\u5747\u5DF2\u4FDD\u7559");
          this.refreshSessions();
        }).catch((e) => this.toast(`\u5220\u9664\u5DE5\u4F5C\u533A\u5931\u8D25: ${e.message}`));
      }
    });
    this.overlay = popup;
    this.focus(popup);
    this.redraw();
  }
  renameWorkspace(group) {
    this.closeOverlay();
    const input = new Input({ x: 2, y: this.screen.h - 3, w: this.screen.w - 4, h: 1, prompt: "\u5DE5\u4F5C\u533A: ", allowEmptyEnter: true, onEnter: () => this.#commitWorkspaceRename(group, input) });
    input.setValue(group.title, { select: true });
    this.renameInput = input;
    this.focus(input);
    this.popup = new Popup({
      x: 1,
      y: this.screen.h - 4,
      w: this.screen.w - 2,
      h: 3,
      title: "\u91CD\u547D\u540D\u5DE5\u4F5C\u533A",
      lines: [],
      buttons: [{ label: "\u4FDD\u5B58", action: "save" }, { label: "\u53D6\u6D88", action: "cancel" }],
      onAction: (btn) => {
        if (btn.action === "save") this.#commitWorkspaceRename(group, input);
        else this.#closeRename();
      }
    });
    this.redraw();
  }
  #commitWorkspaceRename(group, input) {
    const title = input.value.trim();
    if (title === "") {
      this.toast("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
      return;
    }
    this.api.call("workspace.rename", { workspaceId: group.workspaceId, title }).then(() => {
      this.#closeRename();
      this.refreshSessions();
    }).catch((e) => this.toast(`\u91CD\u547D\u540D\u5931\u8D25: ${e.message}`));
  }
  async forkSession(s) {
    try {
      const { sessionId } = await this.api.call("session.fork", { sessionId: s.sessionId });
      await this.refreshSessions();
      this.openSession(sessionId);
      this.toast(`\u5DF2\u5206\u53C9: ${sessionId.slice(0, 8)}`);
    } catch (e) {
      this.toast(`\u5206\u53C9\u5931\u8D25: ${e.message}`);
    }
  }
  async loadFeedback(sessionId = this.currentSession, epoch = this.sessionEpoch) {
    if (!sessionId) return;
    try {
      const res = await this.api.rpcCall("messageFeedback/list", { request: { sessionId } });
      if (sessionId !== this.currentSession || epoch !== this.sessionEpoch) return;
      this.feedbackMap = /* @__PURE__ */ new Map();
      for (const item of res?.value?.items ?? res?.items ?? []) this.feedbackMap.set(item.messageId, item);
    } catch {
      this.feedbackMap = /* @__PURE__ */ new Map();
    }
  }
  async feedback(messageId, rating) {
    const existing = this.feedbackMap?.get(messageId);
    try {
      const res = await this.api.rpcCall("messageFeedback/put", {
        request: {
          sessionId: this.currentSession,
          messageId,
          rating,
          ifVersion: existing?.version ?? null
        }
      });
      if (res?.ok === false) {
        this.toast(`\u53CD\u9988\u5931\u8D25: ${res.error?.code ?? res.error?.message ?? "unknown"}`);
        return;
      }
      const item = res?.value ?? res;
      this.feedbackMap = this.feedbackMap ?? /* @__PURE__ */ new Map();
      this.feedbackMap.set(messageId, item);
      this.toast(rating === "positive" ? "\u5DF2\u8BB0\u5F55 \u{1F44D}" : "\u5DF2\u8BB0\u5F55 \u{1F44E}");
    } catch (e) {
      this.toast(`\u53CD\u9988\u5931\u8D25: ${e.message}`);
    }
  }
  async deleteFeedback(messageId) {
    const existing = this.feedbackMap?.get(messageId);
    if (!existing) return;
    try {
      const res = await this.api.rpcCall("messageFeedback/delete", {
        request: { sessionId: this.currentSession, messageId, ifVersion: existing.version }
      });
      if (res?.ok === false) {
        this.toast(`\u5220\u9664\u53CD\u9988\u5931\u8D25: ${res.error?.code ?? res.error?.message ?? "unknown"}`);
        return;
      }
      this.feedbackMap.delete(messageId);
      this.toast("\u5DF2\u5220\u9664\u53CD\u9988");
    } catch (e) {
      this.toast(`\u5220\u9664\u53CD\u9988\u5931\u8D25: ${e.message}`);
    }
  }
  findInConversation() {
    if (!this.chat.nodes.length) {
      this.toast("\u6CA1\u6709\u4F1A\u8BDD\u5185\u5BB9");
      return;
    }
    this.findQuery = null;
    const items = [];
    this.chat.nodes.forEach((node, i) => {
      let text = "";
      if (node.kind === "user") text = node.text ?? "";
      else if (node.kind === "assistant") {
        text = (node.blocks ?? []).map((b) => b.kind === "text" ? b.text : b.kind === "tool" ? `[${b.name}]` : "").join(" ");
      }
      if (text.trim()) items.push({ label: truncate(text.replace(/\s+/g, " "), 60), hint: node.kind, idx: i, keywords: text });
    });
    const w = Math.min(70, this.screen.w - 4), h = Math.min(20, this.screen.h - 4);
    let picker;
    picker = new Picker({
      x: Math.floor((this.screen.w - w) / 2),
      y: Math.floor((this.screen.h - h) / 2),
      w,
      h,
      title: "\u4F1A\u8BDD\u5185\u641C\u7D22",
      items,
      onCancel: () => this.closeOverlay(),
      onPick: (it) => {
        this.searchQuery = picker.query || null;
        this.closeOverlay();
        this.chat.jumpToNode(it.idx);
      }
    });
    this.overlay = picker;
    this.redraw();
  }
  async exportSession(s) {
    this.toast("\u5BFC\u51FA\u4E2D\u2026");
    try {
      const exported = await this.api.logicalExport(s.sessionId);
      const { writeFileSync: writeFileSync5 } = await import("node:fs");
      const { join: join8 } = await import("node:path");
      const file = join8(process.cwd(), `session-${s.sessionId.slice(0, 8)}-${Date.now()}.json`);
      const json = JSON.stringify(exported, null, 2) + "\n";
      writeFileSync5(file, json, { encoding: "utf8", mode: 384 });
      this.toast(`\u5DF2\u5BFC\u51FA\u903B\u8F91\u4F1A\u8BDD ${Math.round(Buffer.byteLength(json) / 1024)}KB \u2192 ${file}`);
    } catch (e) {
      this.toast(`\u5BFC\u51FA\u5931\u8D25: ${e.message}`);
    }
  }
  async cancelSession(s) {
    await this.api.call("session.cancel", { sessionId: s.sessionId }).catch((e) => this.toast(e.message));
    this.refreshSessions();
  }
  /** ESC 打断: cancel the current turn if it is running. The chat's live
   *  `running` flag (jobs mux frames + streaming nodes) is the fast source;
   *  the (≤5s-fresh) session list is the fallback. Returns true if a cancel
   *  request was actually sent. */
  #interruptIfRunning() {
    if (!this.currentSession) return false;
    const running = this.chat.running || !!this.sessions.find((s) => s.sessionId === this.currentSession)?.running;
    if (!running) return false;
    this.cancelSession({ sessionId: this.currentSession });
    this.toast("\u5DF2\u8BF7\u6C42\u4E2D\u65AD\u5F53\u524D\u56DE\u5408");
    return true;
  }
  async newSessionIn(group = null) {
    const launchWorkspace = process.env.DSH_TUI_WORKSPACE ?? process.cwd();
    const blanks = this.sessions.filter((s) => s.blank && !s.running && s.sessionId !== this.currentSession);
    const blank2 = blanks.find((s) => s.cwd === launchWorkspace) ?? blanks[0];
    if (blank2 && (group?.workspaceId == null || this.#sessionInWorkspace(blank2.sessionId, group.workspaceId))) {
      await this.refreshSessions();
      this.openSession(blank2.sessionId);
      this.toast("\u5DF2\u6253\u5F00\u7A7A\u767D\u4F1A\u8BDD\uFF08\u590D\u7528\u8349\u7A3F\uFF09");
      return;
    }
    this.toast("\u521B\u5EFA\u4F1A\u8BDD\u2026");
    try {
      const payload = group?.workspaceId != null ? { workspaceId: group.workspaceId } : { cwd: group?.path ?? process.env.DSH_TUI_WORKSPACE ?? process.cwd() };
      const { sessionId } = await this.api.call("session.create", payload);
      if (typeof sessionId !== "string" || !sessionId) throw new Error("Host \u672A\u8FD4\u56DE\u4F1A\u8BDD ID");
      await this.refreshSessions();
      this.openSession(sessionId);
    } catch (e) {
      this.toast(`\u521B\u5EFA\u5931\u8D25: ${e.message}`);
    }
  }
  #sessionInWorkspace(sessionId, workspaceId) {
    const ws = this.workspaceItems?.find((w) => w.workspaceId === workspaceId);
    return ws?.sessionIds?.includes(sessionId) ?? false;
  }
  async newSession() {
    return this.newSessionIn(null);
  }
  async openSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
      this.toast("\u65E0\u6CD5\u6253\u5F00\u4F1A\u8BDD\uFF1A\u7F3A\u5C11\u4F1A\u8BDD ID");
      return;
    }
    const epoch = ++this.sessionEpoch;
    this.currentSession = sessionId;
    const cachedProjections = this.cache.get("projections", sessionId) ?? {};
    this.projections = { ...cachedProjections, ...this.projectionsBySession.get(sessionId) ?? {} };
    this.tokenUsage = this.projections.tokenUsage ?? null;
    this.currentModel = null;
    this.feedbackMap = /* @__PURE__ */ new Map();
    this.queueItems = this.queueBySession.get(sessionId) ?? [];
    const snap = this.jobsBySession.get(sessionId);
    this.jobs = snap ?? [];
    if (snap !== void 0) {
      this.chat.running = snap.some((j) => j.status === "running");
    } else if (this.api.connected && typeof this.api.refreshMux === "function") {
      this.api.refreshMux();
    }
    await this.chat.open(sessionId, epoch);
    if (this.chat.lastSeq != null) this.cache.put("cursor", sessionId, { lastSeq: this.chat.lastSeq });
    if (epoch !== this.sessionEpoch || sessionId !== this.currentSession) return;
    if (this.mode === "trajectory" && this.trajectoryPanel) await this.trajectoryPanel.load(sessionId);
    else if (this.fullBuffer && this.fullBuffer === this.subagentPanel) this.subagentPanel.load(sessionId);
    else if (this.fullBuffer && this.fullBuffer === this.skillsPanel) this.skillsPanel.load?.(sessionId);
    if (epoch !== this.sessionEpoch || sessionId !== this.currentSession) return;
    this.loadFeedback(sessionId, epoch);
    this.updateModel(sessionId, epoch);
    this.refreshSubagentStats(sessionId);
    this.redraw();
  }
  /** Read the session's own model selection (provider/model/reasoning effort). */
  async updateModel(sessionId = this.currentSession, epoch = this.sessionEpoch) {
    if (!sessionId) {
      this.currentModel = null;
      return;
    }
    try {
      const res = await this.api.call("session.models", { sessionId });
      if (sessionId !== this.currentSession || epoch !== this.sessionEpoch) return;
      this.currentModel = res.current ?? null;
      try {
        const settings = await this.api.call("settings.describe");
        const providers = settings.namespaces?.find((ns) => ns.ns === "llm-pi-ai")?.value?.providers ?? {};
        const profile = providers[this.currentModel?.provider];
        const model = profile?.models?.find((entry) => entry.id === this.currentModel?.model);
        if (this.currentModel && model?.input) this.currentModel.input = [...model.input];
      } catch {
      }
    } catch {
      this.currentModel = null;
    }
  }
  copyText(text) {
    const b64 = Buffer.from(text).toString("base64");
    this.term.output.write(`\x1B]52;c;${b64}\x07`);
    this.toast("\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF08\u82E5\u7EC8\u7AEF\u652F\u6301 OSC 52\uFF09");
  }
  copyNode(nodeIdx) {
    const node = this.chat.nodes[nodeIdx];
    if (!node) return;
    const text = node.kind === "user" ? node.text : node.blocks?.map((b) => b.text ?? "").join("\n");
    this.copyText(text ?? "");
  }
  setMode(mode) {
    this.mode = mode === "trajectory" ? "trajectory" : "chat";
    if (this.mode === "trajectory") {
      if (!this.currentSession) {
        this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
        this.mode = "chat";
        this.redraw();
        return;
      }
      if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
      this.trajectoryPanel.load(this.currentSession);
    }
    const panel = this.panelForMode();
    if (panel && this.focused !== this.sidebar) this.focus(panel);
    else if (this.focused !== this.sidebar) this.focus(this.chat);
    this.layout();
    this.redraw();
  }
  panelForMode() {
    return this.mode === "trajectory" ? this.trajectoryPanel : null;
  }
  /** Full-screen modal buffers replace the old tab-page modes: they coexist
   *  with the sidebar/chat/trajectory pane focus instead of fighting it. */
  openFullBuffer(panel) {
    if (!panel) return;
    this.fullBuffer = panel;
    panel.relayout(0, 0, this.screen.w, this.screen.h);
    this.focus(panel);
    this.redraw();
  }
  closeFullBuffer() {
    if (!this.fullBuffer) return true;
    this.fullBuffer = null;
    this.focus(this.chat);
    this.layout();
    this.redraw();
    return true;
  }
  showWorkspaceBuffer() {
    if (!this.workspacePanel) this.workspacePanel = new WorkspacePanel(this);
    this.openFullBuffer(this.workspacePanel);
    this.workspacePanel.load();
  }
  showSettingsBuffer() {
    if (!this.settingsPanel) this.settingsPanel = new SettingsPanel(this);
    this.openFullBuffer(this.settingsPanel);
    this.settingsPanel.load();
  }
  showModelsBuffer() {
    if (!this.modelPanel) this.modelPanel = new ModelPanel(this);
    this.openFullBuffer(this.modelPanel);
    this.modelPanel.load();
  }
  showSubagentBuffer() {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    if (!this.subagentPanel) this.subagentPanel = new SubagentPanel(this);
    this.openFullBuffer(this.subagentPanel);
    this.subagentPanel.load(this.currentSession);
  }
  showSkillsBuffer() {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    if (!this.skillsPanel) this.skillsPanel = new SkillsPanel(this);
    this.openFullBuffer(this.skillsPanel);
    this.skillsPanel.load();
  }
  closeOverlay() {
    this.overlay = null;
    this.redraw();
  }
  openSessionPicker() {
    const w = Math.min(70, this.screen.w - 4), h = Math.min(20, this.screen.h - 4);
    this.overlay = new Picker({
      x: Math.floor((this.screen.w - w) / 2),
      y: Math.floor((this.screen.h - h) / 2),
      w,
      h,
      title: "\u6253\u5F00\u4F1A\u8BDD",
      items: this.sessions.map((ss) => ({
        label: ss.projections?.values?.title ?? ss.sessionId.slice(0, 8),
        hint: ss.origin === "subagent" ? "\u5B50\u4EE3\u7406" : ss.cwd ?? "",
        action: () => this.openSession(ss.sessionId),
        keywords: ss.sessionId
      })),
      onCancel: () => this.closeOverlay(),
      onPick: (it) => {
        this.overlay = null;
        it.action();
        this.redraw();
      }
    });
    this.redraw();
  }
  renameCurrent() {
    const s = this.sessions.find((x) => x.sessionId === this.currentSession);
    if (s) this.renameSession(s);
    else this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
  }
  showJobs() {
    this.overlay = new JobsPanel(this);
    this.refreshSubagentStats();
    this.redraw();
  }
  async refreshSubagentStats(sessionId = this.currentSession) {
    if (!sessionId) return;
    try {
      const res = await this.api.call("subagent.list", { parentSessionId: sessionId });
      const entries = (res.entries ?? res.items ?? []).filter((entry) => entry.kind !== "diagnostic");
      const stats = { running: entries.filter((entry) => entry.activity === "running").length, completed: entries.filter((entry) => entry.activity === "inactive").length, total: entries.length };
      this.subagentStatsBySession.set(sessionId, stats);
      if (sessionId === this.currentSession) this.redraw();
    } catch {
    }
  }
  showQueue() {
    this.overlay = new QueuePanel(this);
    this.redraw();
  }
  showGoal() {
    this.overlay = buildGoalPopup(this);
    this.redraw();
  }
  showModePicker() {
    this.overlay = buildModePicker(this);
    this.redraw();
  }
  showPermissionPicker() {
    this.overlay = buildPermissionPicker(this);
    this.redraw();
  }
  /** /reload: in-place soft reload — fresh session list, fresh chat history,
   *  panels rebuilt, screen re-rendered. No process churn, no terminal
   *  handoff (the old process-restart approach leaked mouse bytes into the
   *  boot of the new instance). */
  async softReload() {
    this.closeOverlay();
    this.menu = null;
    this.popup = null;
    this.activePrompt = null;
    this.promptQueue = [];
    for (const p of [this.workspacePanel, this.trajectoryPanel, this.settingsPanel, this.modelPanel, this.subagentPanel, this.skillsPanel]) {
      if (p?.dispose) {
        try {
          p.dispose();
        } catch {
        }
      }
    }
    this.workspacePanel = this.trajectoryPanel = this.settingsPanel = this.modelPanel = this.subagentPanel = this.skillsPanel = null;
    this.chat.cache.clear();
    this.chat.nodes = [];
    this.chat.collapsedBlocks.clear();
    this.chat.expanded.clear();
    this.chat.queueRebuild();
    this.chat.view.anchorLock = null;
    this.mode = "chat";
    this.focus(this.chat);
    this.toast("\u6B63\u5728\u91CD\u65B0\u52A0\u8F7D\u2026");
    await this.refreshSessions();
    if (this.currentSession) await this.openSession(this.currentSession);
    else await this.newSessionIn(null);
    this.layout();
    this.redraw();
    this.toast("\u5DF2\u91CD\u65B0\u52A0\u8F7D\u4F1A\u8BDD\u4E0E\u754C\u9762");
  }
  /** /restart: restart the TUI process in the same terminal so a freshly
   *  published build (the profile symlinks the repo) takes effect. The new
   *  instance starts one second after this process restores the terminal —
   *  no stray mouse/keyboard bytes leak into its boot. */
  async restartApp() {
    this.toast("\u6B63\u5728\u91CD\u542F TUI\uFF08\u52A0\u8F7D\u65B0\u7248\u672C\u4EE3\u7801\uFF09\u2026");
    this.redraw();
    await new Promise((r) => setTimeout(r, 250));
    try {
      this.term?.stop?.();
    } catch {
    }
    try {
      const env = { ...process.env, DSH_TUI_RESTART_HANDOFF: "1", DSH_TUI_RESUME_SESSION: this.currentSession ?? "", DSH_TUI_RESUME_SCROLL: String(this.chat?.view?.scrollY ?? 0), DSH_TUI_RESUME_FOLLOW: this.chat?.view?.follow ? "1" : "0" };
      restartProcess(process.argv.slice(1), env);
    } catch (e) {
      this.toast(`\u91CD\u542F\u5931\u8D25: ${e.message}\uFF08\u8BF7\u624B\u52A8\u91CD\u542F\uFF09`);
      return;
    }
    process.exit(0);
  }
  /** Ctrl+E: fzf-style quick jump to a step — type to fuzzy-filter the step
   *  list, Enter opens the trajectory window around the picked step. */
  async quickJumpStep() {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    if (!this.trajectoryPanel) this.trajectoryPanel = new TrajectoryPanel(this);
    const tp = this.trajectoryPanel;
    if (tp.sessionId !== this.currentSession || tp.steps.length === 0) {
      this.setStatus("\u52A0\u8F7D\u6B65\u9AA4\u5217\u8868\u2026");
      await tp.load(this.currentSession);
      this.setStatus("");
    }
    const total = tp.stats?.steps ?? (tp.steps[tp.steps.length - 1]?.step ?? tp.steps.length);
    const items = [...tp.steps].reverse().map((st) => {
      const si = tp.steps.indexOf(st);
      const tools = [...new Set(st.events.filter((e) => e.type === "tool/call").map((e) => e.data?.name))];
      const t0 = st.events[0]?.time, t1 = st.events[st.events.length - 1]?.time;
      const dur = t0 && t1 ? fmtMs(t1 - t0) : "\u2014";
      const userMsg = st.events.find((e) => e.type === "user/message")?.data?.content?.[0]?.text ?? "";
      return {
        label: `step ${st.step}  ${dur}  ${tools.slice(0, 3).join(",") || "\u7EAF\u6587\u672C"}  ${truncate(String(userMsg), 24)}`,
        hint: `${st.events.length} \u4E8B\u4EF6`,
        keywords: `step ${st.step} ${tools.join(" ")} ${userMsg}`,
        stepIdx: si
      };
    });
    const w = Math.min(76, this.screen.w - 8), h = Math.min(20, this.screen.h - 4);
    this.overlay = new Picker({
      x: Math.floor((this.screen.w - w) / 2),
      y: Math.floor((this.screen.h - h) / 2),
      w,
      h,
      title: `\u6B65\u9AA4\u8F6C\u8DF3\uFF08step 1\u2013${total} \xB7 Ctrl+E\uFF09\u2014 \u8F93\u5165\u8FC7\u6EE4,\u56DE\u8F66\u5B9A\u4F4D`,
      items,
      onCancel: () => this.closeOverlay(),
      onPick: (it) => {
        this.closeOverlay();
        this.setMode("trajectory");
        this.trajectoryPanel.jumpToStep(it.stepIdx);
      }
    });
    this.redraw();
  }
  /** Select one of the four agent presets (modes). */
  async selectPreset(id) {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    const sess = this.sessions.find((s) => s.sessionId === this.currentSession);
    if (sess && !sess.blank) {
      this.toast(`\u5F53\u524D\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF08\u6A21\u5F0F\u56FA\u5B9A\uFF09\uFF1B\u5DF2\u8BBE\u4E3A\u65B0\u4F1A\u8BDD\u9ED8\u8BA4`);
      this.setDefaultPreset(id);
      return;
    }
    try {
      await this.api.call("agentPreset.select", { sessionId: this.currentSession, agentPreset: id });
      if (sess) sess.agentPreset = id;
      this.toast(`\u6A21\u5F0F\u5DF2\u5207\u6362: ${modeName(id)}`);
      this.redraw();
      this.refreshSessions();
    } catch (e) {
      if (e.code === "agent-preset-locked") {
        this.toast("\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6A21\u5F0F\u56FA\u5B9A\uFF1B\u5DF2\u8BBE\u4E3A\u65B0\u4F1A\u8BDD\u9ED8\u8BA4");
        this.setDefaultPreset(id);
      } else this.toast(`\u5207\u6362\u5931\u8D25: ${e.message}`);
    }
  }
  async setDefaultPreset(id) {
    try {
      const d = await this.api.call("settings.describe");
      const ns = (d.namespaces ?? []).find((n) => n.ns === "agent-presets");
      if (!ns) {
        this.toast("\u6B64\u90E8\u7F72\u4E0D\u652F\u6301\u8BBE\u7F6E\u9ED8\u8BA4\u6A21\u5F0F");
        return;
      }
      await this.api.call("settings.mutate", { ns: "agent-presets", ops: [{ op: "set", path: ["default"], value: id }], expectedRevision: ns.revision });
      this.toast(`\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u6A21\u5F0F: ${modeName(id)}`);
    } catch (e) {
      this.toast(`\u8BBE\u7F6E\u9ED8\u8BA4\u6A21\u5F0F\u5931\u8D25: ${e.message}`);
    }
  }
  /** Switch the current session's permission preset (three-way). */
  switchPermission(preset) {
    if (!this.currentSession) {
      this.toast("\u5148\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    const current2 = this.projections.permissions?.currentValue;
    if (preset === current2) return;
    if (preset === "danger-full-access") {
      const w = Math.min(64, this.screen.w - 4);
      this.overlay = new Popup({
        x: Math.floor((this.screen.w - w) / 2),
        y: Math.floor(this.screen.h / 2) - 3,
        w,
        h: 7,
        title: "\u786E\u8BA4\u542F\u7528\u5B8C\u5168\u8BBF\u95EE\uFF1F",
        lines: ["", "  \u51CF\u5C11\u786E\u8BA4\u6B65\u9AA4\uFF0C\u53EF\u76F4\u63A5\u6267\u884C\u654F\u611F\u64CD\u4F5C\u3001\u6587\u4EF6\u4FEE\u6539\u6216\u5916\u90E8\u547D\u4EE4\u3002"],
        buttons: [{ label: "\u53D6\u6D88", action: "cancel" }, { label: "\u542F\u7528", action: "confirm" }],
        onAction: (btn) => {
          this.closeOverlay();
          if (btn.action === "confirm") this.doSwitchPermission(preset);
        }
      });
      this.redraw();
      return;
    }
    this.doSwitchPermission(preset);
  }
  async doSwitchPermission(preset) {
    try {
      const res = await this.api.rpcCall("commands/execute", { agentId: this.currentSession, line: `/permission ${preset}` });
      const text = res?.result?.text ?? "";
      this.toast(`\u6743\u9650\u5DF2\u5207\u6362: ${text || permName(preset)}`);
    } catch (e) {
      this.toast(`\u6743\u9650\u5207\u6362\u5931\u8D25: ${e.message}`);
    }
  }
  /** F8: cycle read-only → workspace-write → danger-full-access. */
  rotatePermission() {
    const order = ["read-only", "workspace-write", "danger-full-access"];
    const cur = this.projections.permissions?.currentValue;
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    this.switchPermission(next);
  }
  /** Execute an editable global binding (two slots per id). */
  #runBinding(id, slot) {
    switch (id) {
      case "sessionFilter":
        this.startSearch();
        this.redraw();
        return true;
      case "panel":
        this.overlay = new ControlPanel(this, { startPage: 0 });
        this.redraw();
        return true;
      case "homeSwitch":
        this.focusPane(slot === "key" ? -1 : 1);
        return true;
      case "permissionRotate":
        this.rotatePermission();
        return true;
      case "editConfig":
        this.editConfigFile();
        return true;
      case "quit":
        this.stop();
        return true;
      case "model":
        this.overlay = buildModelPicker(this);
        this.redraw();
        return true;
      case "trajectory":
        this.setMode("trajectory");
        return true;
      case "workspace":
        this.showWorkspaceBuffer();
        return true;
      case "settings":
        this.showSettingsBuffer();
        return true;
      case "subagent":
        this.showSubagentBuffer();
        return true;
      case "skills":
        this.showSkillsBuffer();
        return true;
      case "goal":
        this.showGoal();
        return true;
      case "jobs":
        this.showJobs();
        return true;
      case "queue":
        this.showQueue();
        return true;
      case "busyEnter": {
        const next = busyEnter() === "queue" ? "steer" : "queue";
        saveTuiConfig({ busyEnter: next });
        this.toast(`\u8FD0\u884C\u4E2D Enter\uFF1A${next === "steer" ? "\u8FFD\u52A0\u5230\u5F53\u524D\u56DE\u5408" : "\u52A0\u5165\u961F\u5217"}`);
        return true;
      }
      case "attachments":
        this.overlay = new AttachmentPanel(this);
        this.focus(this.overlay);
        this.redraw();
        return true;
      case "stepJump":
        this.quickJumpStep();
        return true;
      case "sidebar":
        this.toggleSidebar();
        return true;
      default:
        return false;
    }
  }
  /** Ctrl+K: open tui-config.json in $EDITOR (default editor). The terminal is
   *  restored around the editor, then re-entered; the config cache is dropped
   *  so the new bindings apply immediately. */
  async editConfigFile() {
    const file = tuiConfigFile();
    const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad.exe" : "vi");
    this.toast(`\u5728 ${editor} \u4E2D\u6253\u5F00 ${file}\u2026`);
    this.redraw();
    await new Promise((r) => setTimeout(r, 150));
    try {
      this.term?.stop?.();
    } catch {
    }
    try {
      this.spawnEditor(file, editor);
    } catch (e) {
      this.toast(`\u7F16\u8F91\u5668\u542F\u52A8\u5931\u8D25: ${e.message}`);
    }
    try {
      this.term?.start?.();
    } catch {
    }
    reloadTuiConfig();
    this.layout();
    this.redraw();
    this.toast("\u914D\u7F6E\u7F16\u8F91\u5B8C\u6210\uFF1B\u5FEB\u6377\u952E\u5DF2\u91CD\u65B0\u52A0\u8F7D");
  }
  spawnEditor(file, editor) {
    runEditor(file, editor);
  }
  showFilePicker() {
    this.overlay = new UploadPicker(this, { startPath: process.cwd(), onUpload: (files) => {
      let added = 0;
      for (const file of files) {
        if (!IMAGE_EXT.test(file.path)) {
          this.toast(`Host \u5F53\u524D\u4EC5\u63A5\u53D7\u56FE\u7247\u9644\u4EF6\uFF1B\u5DF2\u8DF3\u8FC7 ${file.name}`);
          continue;
        }
        try {
          const ext = IMAGE_EXT.exec(file.path)[1].toLowerCase();
          const mediaType = MEDIA_TYPES[ext];
          const data = (0, import_node_fs7.readFileSync)(file.path, "base64");
          const item = { id: `file-${Date.now()}-${added}`, path: file.path, local: true, name: file.name, mediaType, data, bytes: Buffer.byteLength(data, "base64") };
          this.chat.clipboardImages.push(item);
          this.chat.attachments.push(item);
          added++;
        } catch (e) {
          this.toast(`\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: ${file.name}: ${e.message}`);
        }
      }
      this.chat.inputChanged();
      if (added) this.toast(`\u5DF2\u6DFB\u52A0 ${added} \u4E2A\u56FE\u7247\u9644\u4EF6`);
    }, onCancel: () => {
      this.overlay = null;
      this.focus(this.chat.input);
      this.redraw();
    } });
    this.focus(this.overlay);
    this.redraw();
  }
  openImage(ref, opts = {}) {
    this.overlay = new ImagePopup({ app: this, ref, sessionId: this.currentSession, refs: opts.all, index: opts.index ?? 0, returnTo: opts.returnTo ?? null });
    this.redraw();
  }
  get goalData() {
    return this.projections.goal;
  }
  get todos() {
    return this.projections.todos;
  }
  get goalText() {
    const g = this.projections.goal?.goal ?? this.projections.goal;
    return typeof g === "string" ? g : g?.objective ?? null;
  }
  #modeTabs() {
    return [
      ["chat", "\u5BF9\u8BDD"],
      ["trajectory", "\u8F68\u8FF9"]
    ];
  }
  #renderTabBar(s) {
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const w = this.screen.w - x;
    s.fillRect(x, 0, x + w - 1, 0, " ", { bg: T.PANEL });
    const tabs = [...this.#modeTabs()];
    let tx = x;
    const sidebarFocused = this.focused === this.sidebar;
    for (const [id, label] of tabs) {
      const sel = !sidebarFocused && id === this.mode;
      const seg = ` ${label} `;
      s.text(tx, 0, seg, { fg: sel ? T.SELFG : T.DIM, bg: sel ? T.ACCENT : T.PANEL, attrs: sel ? 1 : 0 });
      tx += strWidth(seg);
    }
    if (this.currentSession == null) s.text(x + w - 16, 0, "\u672A\u9009\u4F1A\u8BDD", { fg: T.FAINT, bg: T.PANEL });
  }
  #clickTab(px) {
    const x = this.sidebarVisible ? this.sidebarWidth : 0;
    const tabs = [...this.#modeTabs()];
    let tx = x;
    for (const [id, label] of tabs) {
      const seg = ` ${label} `;
      if (px >= tx && px < tx + strWidth(seg)) {
        this.setMode(id);
        return true;
      }
      tx += strWidth(seg);
    }
    return false;
  }
  // ---- dispatch ----
  onEvent(ev) {
    if (ev.type === "resize") {
      this.resize(ev.w, ev.h);
      return;
    }
    if (this.swallowRelease && ev.type === "mouse" && ev.kind === "release") {
      this.swallowRelease = false;
      return;
    }
    if (this.swallowRelease && ev.type === "mouse") return;
    this.swallowRelease = false;
    if (this.renameInput) {
      if (ev.type === "key" && ev.name === "escape") {
        this.#closeRename();
        return;
      }
      if (ev.type === "key" || ev.type === "text") {
        this.renameInput.onKey(ev);
      }
      this.redraw();
      return;
    }
    if (this.popup) {
      const before = this.popup;
      if (ev.type === "key" || ev.type === "text") this.popup.onKey(ev);
      else if (ev.type === "mouse") {
        this.popup.onMouse(ev);
        if (ev.kind === "press" && this.popup !== before) this.swallowRelease = true;
      }
      this.redraw();
      return;
    }
    if (this.menu) {
      const before = this.menu;
      if (ev.type === "key") {
        this.menu.onKey(ev);
        this.redraw();
        return;
      }
      if (ev.type === "mouse") {
        if (ev.kind === "press" && ev.button === 0 && !this.menu.inside(ev.x, ev.y)) {
          this.menu = null;
          this.swallowRelease = true;
          this.redraw();
          return;
        }
        if (ev.kind === "press" && ev.button === 2) {
          if (this.menu.inside(ev.x, ev.y)) {
            this.redraw();
            return;
          }
          this.menu = null;
          this.swallowRelease = true;
          this.redraw();
        } else {
          this.menu.onMouse(ev);
          if (ev.kind === "press" && this.menu !== before) this.swallowRelease = true;
          this.redraw();
          return;
        }
      } else {
        this.redraw();
        return;
      }
    }
    if (this.overlay) {
      const before = this.overlay;
      if (ev.type === "key" || ev.type === "text") this.overlay.onKey(ev);
      else if (ev.type === "mouse") {
        if (ev.kind === "press" && ev.button === 0 && !this.overlay.inside(ev.x, ev.y)) {
          this.swallowRelease = true;
        } else {
          this.overlay.onMouse(ev);
          if (ev.kind === "press" && this.overlay !== before) this.swallowRelease = true;
        }
      }
      this.redraw();
      return;
    }
    if (this.fullBuffer) {
      if (ev.type === "mouse") {
        if (this.fullBuffer.onMouse?.(ev)) this.redraw();
      } else {
        const handled = this.fullBuffer.onKey?.(ev);
        if (ev.type === "key" && ev.name === "escape" && !handled) this.closeFullBuffer();
        else this.redraw();
      }
      return;
    }
    if (ev.type === "mouse" && ev.kind === "press" && ev.button === 0 && ev.y === 0 && ev.x >= (this.sidebarVisible ? this.sidebarWidth : 0)) {
      if (this.#clickTab(ev.x)) {
        this.redraw();
        return;
      }
    }
    if (this.mode !== "chat") {
      if (ev.type === "mouse" && this.sidebarVisible && this.sidebar.inside(ev.x, ev.y)) {
        if (this.focused !== this.chat.input) this.focus(this.sidebar);
        if (this.sidebar.onMouse(ev)) this.redraw();
        return;
      }
      const panel = this.panelForMode();
      const paneSwitch = ev.type === "key" && ev.ctrl && (ev.name === "left" || ev.name === "right");
      if (panel && this.focused !== this.sidebar && !paneSwitch) {
        const handled = ev.type === "key" || ev.type === "text" || ev.type === "paste" ? panel.onKey(ev) : panel.onMouse(ev);
        if (handled) {
          this.redraw();
          return;
        }
        if (ev.type === "text" || ev.type === "paste") {
          this.redraw();
          return;
        }
      }
    }
    if (ev.type === "mouse") {
      if (ev.kind === "release" && ev.button === 0 && this.inputDrag) {
        this.inputDrag = false;
        if (this.chat.input.onMouse(ev)) this.redraw();
        return;
      }
      const divX = this.sidebarVisible ? this.sidebarWidth : -1;
      const onDivider = divX >= 0 && ev.y >= 1 && ev.x >= divX - 1 && ev.x <= divX + 1;
      if (ev.kind === "press" && ev.button === 0 && onDivider) {
        this.draggingDivider = true;
        this.redraw();
        return;
      }
      if (this.draggingDivider) {
        if (ev.kind === "drag" && ev.button === 0) {
          const nw = Math.max(14, Math.min(ev.x, Math.floor(this.screen.w * 0.6)));
          if (nw !== this.sidebarWidth) {
            this.sidebarWidth = nw;
            this.layout();
            this.redraw();
          }
          return;
        }
        if (ev.kind === "release" && ev.button === 0) {
          this.draggingDivider = false;
          this.redraw();
          return;
        }
      }
      if (ev.motion) {
        if (this.inputDrag) {
          if (this.chat.input.onMouse(ev)) this.redraw();
          return;
        }
        if (this.focused?.onMouse?.(ev)) this.redraw();
        return;
      }
      if (this.sidebarVisible && this.sidebar.inside(ev.x, ev.y)) {
        if (this.focused !== this.chat.input) this.focus(this.sidebar);
        if (this.sidebar.onMouse(ev)) this.redraw();
      } else if (this.chat.input.inside(ev.x, ev.y)) {
        if (ev.kind === "press" && ev.button === 0) {
          this.focus(this.chat.input);
          this.inputDrag = true;
          if (this.chat.input.onMouse(ev)) this.redraw();
        } else if (ev.kind === "release" && ev.button === 0) {
          this.inputDrag = false;
          if (this.chat.input.onMouse(ev)) this.redraw();
        } else if (this.focused === this.chat.input) {
          if (this.chat.input.onMouse(ev)) this.redraw();
        }
      } else if (this.chat.inside(ev.x, ev.y)) {
        if (this.focused !== this.chat.input) this.focus(this.chat);
        if (this.chat.onMouse(ev)) this.redraw();
      } else if (this.focused?.onMouse?.(ev)) {
        this.redraw();
      }
      return;
    }
    if (ev.type === "paste" && this.focused === this.chat.input) {
      if (!this.chat.pasteClipboardImage()) this.chat.input.onKey(ev);
      this.redraw();
      return;
    }
    if (ev.type === "key") {
      if (this.focused === this.chat.input) {
        if (ev.name === "escape") {
          if (this.chat.input.cmdOpen) {
            this.chat.input.cmdOpen = false;
            this.redraw();
            return;
          }
          this.focus(this.chat);
          this.toast(this.chat.running ? "\u5DF2\u9000\u51FA\u8F93\u5165\uFF1BCtrl+C \u53EF\u4E2D\u65AD\u5F53\u524D\u56DE\u5408" : "\u5DF2\u9000\u51FA\u8F93\u5165\uFF08i \u91CD\u65B0\u8FDB\u5165\uFF09");
        } else if (ev.ctrl && ev.key === "o") {
          this.showFilePicker();
        } else if (ev.ctrl && ev.shift && ev.key === "v") {
          if (!this.chat.pasteClipboardImage()) this.chat.input.onKey(ev);
        } else {
          this.chat.input.onKey(ev);
        }
        this.redraw();
        return;
      }
      if (this.searchActive) {
        this.#onSearchKey(ev);
        this.redraw();
        return;
      }
      const hit = bindingMatchFor(ev, keyBindings(), false, KEYBINDING_ORDER);
      if (hit && this.#runBinding(hit.id, hit.slot)) return;
      if (ev.ctrl && ev.shift && ev.key === "c") {
        if (this.focused === this.chat) this.chat.onKey(ev);
        else this.toast("\u8BF7\u5148\u5728\u6B63\u6587\u4E2D\u9009\u62E9\u8981\u590D\u5236\u7684\u5185\u5BB9");
        this.redraw();
        return;
      }
      if (ev.ctrl && ev.key === "c" && !ev.shift) {
        if (this.focused === this.chat?.input) return false;
        const now = Date.now();
        if (this.ctrlCUntil != null && now < this.ctrlCUntil) {
          this.stop();
          return;
        }
        this.ctrlCUntil = now + 3e3;
        this.toast("\u518D\u6309\u4E00\u6B21 Ctrl+C \u9000\u51FA TUI");
        return;
      }
      if (ev.ctrl && ev.shift && ev.key === "w") {
        this.addWorkspace();
        return;
      }
      if (ev.ctrl && ev.key === "p") {
        this.overlay = new ControlPanel(this, { startPage: 1 });
        this.redraw();
        return;
      }
      if (ev.name === "f9") {
        this.showModePicker();
        return;
      }
      if (ev.name === "escape") {
        if (this.#interruptIfRunning()) return;
        if (this.focused === this.sidebar) {
          this.focus(this.chat);
          this.redraw();
        } else if (this.mode !== "chat") this.setMode("chat");
        return;
      }
    }
    if ((ev.type === "text" || ev.type === "paste") && this.focused !== this.chat.input) {
      if (this.searchActive) {
        this.#onSearchKey(ev);
        this.redraw();
        return;
      }
      if (graphemes(ev.text).length === 1) {
        const text = graphemes(ev.text)[0];
        const asKey = {
          type: "key",
          name: "char",
          key: text.toLowerCase(),
          text,
          ctrl: false,
          alt: false,
          shift: text !== text.toLowerCase()
        };
        if (this.focused && this.focused !== this.chat && this.focused !== this.chat.input && this.focused.onKey?.(asKey)) {
          this.redraw();
          return;
        }
        if (this.chat.onKey(asKey)) {
          this.redraw();
          return;
        }
        if (this.focused && this.focused !== this.chat.input && this.focused.onKey?.(asKey)) {
          this.redraw();
          return;
        }
        this.toast("\u6309 i \u8FDB\u5165\u8F93\u5165");
        return;
      }
      this.focus(this.chat.input);
      this.chat.input.onKey(ev);
      this.redraw();
      return;
    }
    if (this.focused) {
      const handled = ev.type === "mouse" ? this.focused.onMouse?.(ev) : this.focused.onKey?.(ev);
      if (handled) this.redraw();
    }
  }
  startSearch() {
    this.searchSeq++;
    this.searchActive = true;
    this.searchInput.setValue("");
    this.searchState = { phase: "input", query: "", rows: [], selected: 0, collapsed: /* @__PURE__ */ new Set(), typeFold: /* @__PURE__ */ new Set(), preview: [], previewScroll: 0, loading: false, hasMore: false, fallback: false, fallbackError: null };
    this.focus(this.searchInput);
    this.redraw();
  }
  #searchWorkspaceFor(sessionId) {
    const ws = (this.workspaceItems ?? []).find((item) => (item.sessionIds ?? []).includes(sessionId));
    return ws ? { key: ws.workspaceId ?? ws.id ?? ws.path, title: ws.title ?? ws.name ?? ws.path ?? "\u5DE5\u4F5C\u533A" } : { key: "ungrouped", title: "\u672A\u5206\u7EC4" };
  }
  #searchBlockText(node, block = null) {
    if (!block) return String(node?.text ?? "");
    const fields = [block.name, block.text, block.args, block.result];
    return fields.filter((value) => value != null && value !== "").map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }).join("\n");
  }
  #mergeHistoryEvents(older, newer) {
    const bySeq = /* @__PURE__ */ new Map();
    for (const wrapped of [...older ?? [], ...newer ?? []]) {
      const seq = wrapped?.event?.seq;
      if (seq == null) continue;
      bySeq.set(seq, wrapped);
    }
    return [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
  }
  /** Resolve one Host search hit into session-level matches. `deep` pages back
   *  toward the FTS hit; fallback scans stay on the single tail page. */
  async #resolveSearchSession(sessionId, snippet, lower, seq, state, { deep = true } = {}) {
    let history;
    try {
      history = await this.api.call("session.history", { sessionId, maxMessages: 80 });
    } catch {
      history = { events: [], hasMore: false };
    }
    if (seq !== this.searchSeq || !this.searchActive || this.searchState !== state) return null;
    let allEvents = this.#mergeHistoryEvents([], history.events);
    const contains = (list) => list.some((node) => node.kind === "assistant" ? (node.blocks ?? []).some((block) => this.#searchBlockText(node, block).toLowerCase().includes(lower)) : this.#searchBlockText(node).toLowerCase().includes(lower));
    let resolved = contains(nodeForEvents(allEvents, this.log));
    for (let page = 0; deep && !resolved && history.hasMore && page < 40; page++) {
      const beforeSeq = allEvents[0]?.event?.seq;
      if (beforeSeq == null) break;
      const older = await this.api.call("session.history", { sessionId, beforeSeq, maxMessages: 80 });
      if (seq !== this.searchSeq || !this.searchActive || this.searchState !== state) return null;
      const merged = this.#mergeHistoryEvents(older.events, allEvents);
      const newBeforeSeq = merged[0]?.event?.seq;
      if (!older.events?.length || newBeforeSeq == null || newBeforeSeq >= beforeSeq) {
        history = { ...history, hasMore: false };
        break;
      }
      resolved = contains(nodeForEvents(older.events, this.log));
      allEvents = merged;
      history = { ...older, events: allEvents };
    }
    const nodes = nodeForEvents(allEvents, this.log);
    const matches = [];
    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      if (node.kind === "assistant") {
        for (let bi = 0; bi < (node.blocks ?? []).length; bi++) {
          const block = node.blocks[bi], text = this.#searchBlockText(node, block);
          if (text.toLowerCase().includes(lower)) matches.push({ nodeIdx: ni, blockIdx: bi, kind: block.kind, text, seq: node.firstSeq ?? node.lastSeq });
        }
      } else {
        const text = this.#searchBlockText(node);
        if (text.toLowerCase().includes(lower)) matches.push({ nodeIdx: ni, blockIdx: null, kind: node.kind, text, seq: node.firstSeq ?? node.lastSeq });
      }
    }
    if (!matches.length && deep) matches.push({ nodeIdx: -1, blockIdx: null, kind: "snippet", text: snippet ?? "", seq: null, approximate: true });
    const session = this.sessions.find((item) => item.sessionId === sessionId);
    return { sessionId, title: session?.projections?.values?.title ?? sessionId.slice(0, 8), snippet: snippet ?? "", nodes, matches, hasMore: history.hasMore, beforeSeq: allEvents[0]?.event?.seq ?? null };
  }
  /** Bounded local scan over loaded sessions when the Host FTS index is absent. */
  async #localSearchFallback(query, lower, seq, state) {
    const groups = /* @__PURE__ */ new Map();
    const candidates = (this.sessions ?? []).filter((session) => !session.blank).slice(0, 20);
    for (const session of candidates) {
      const entry = await this.#resolveSearchSession(session.sessionId, "", lower, seq, state, { deep: false });
      if (entry === null) return null;
      if (entry.matches.length === 0) continue;
      const ws = this.#searchWorkspaceFor(session.sessionId);
      if (!groups.has(ws.key)) groups.set(ws.key, { ...ws, sessions: [] });
      groups.get(ws.key).sessions.push(entry);
    }
    return [...groups.values()];
  }
  async #executeSearch() {
    const state = this.searchState;
    const query = this.searchInput.value.trim();
    if (!state || !query || state.loading) {
      if (!query) this.toast("\u8BF7\u8F93\u5165\u641C\u7D22\u5185\u5BB9");
      return;
    }
    state.loading = true;
    state.error = null;
    state.fallback = false;
    state.fallbackError = null;
    state.phase = "results";
    state.query = query;
    state.rows = [];
    state.preview = [];
    state.selected = 0;
    this.focus(this);
    this.redraw();
    const seq = ++this.searchSeq;
    const lower = query.toLowerCase();
    try {
      const result = await this.api.call("session.search", { query });
      const groups = /* @__PURE__ */ new Map();
      for (const hit of result.items ?? []) {
        const entry = await this.#resolveSearchSession(hit.sessionId, hit.snippet ?? "", lower, seq, state, { deep: true });
        if (entry === null) return;
        const ws = this.#searchWorkspaceFor(hit.sessionId);
        if (!groups.has(ws.key)) groups.set(ws.key, { ...ws, sessions: [] });
        groups.get(ws.key).sessions.push(entry);
      }
      if (seq !== this.searchSeq || !this.searchActive || this.searchState !== state) return;
      state.groups = [...groups.values()];
      state.hasMore = !!result.hasMore;
      state.loading = false;
      this.#flattenSearchRows();
    } catch (error) {
      if (seq !== this.searchSeq || !this.searchActive || this.searchState !== state) return;
      const groups = await this.#localSearchFallback(query, lower, seq, state);
      if (groups === null) return;
      state.groups = groups;
      state.hasMore = false;
      state.loading = false;
      state.fallback = true;
      state.fallbackError = error.message;
      this.#flattenSearchRows();
      this.toast("Host \u641C\u7D22\u7D22\u5F15\u4E0D\u53EF\u7528\uFF1B\u5DF2\u6539\u7528\u672C\u5730\u6709\u754C\u626B\u63CF");
    }
    if (seq === this.searchSeq && this.searchState === state) this.redraw();
  }
  #flattenSearchRows() {
    const state = this.searchState;
    if (!state) return;
    const rows = [];
    for (const group of state.groups ?? []) {
      rows.push({ kind: "workspace", key: `w:${group.key}`, group });
      if (state.collapsed.has(`w:${group.key}`)) continue;
      for (const session of group.sessions) {
        rows.push({ kind: "session", key: `s:${session.sessionId}`, session, group });
        if (state.collapsed.has(`s:${session.sessionId}`)) continue;
        for (let mi = 0; mi < session.matches.length; mi++) {
          const match = session.matches[mi];
          if (state.typeFold.has(match.kind)) continue;
          rows.push({ kind: "match", key: `m:${session.sessionId}:${mi}`, session, group, match, matchIndex: mi });
        }
      }
    }
    state.rows = rows;
    state.selected = Math.min(state.selected, Math.max(0, rows.length - 1));
    this.#updateSearchPreview();
  }
  #updateSearchPreview() {
    const state = this.searchState;
    const row = state?.rows[state.selected];
    if (!state) return;
    if (row?.kind === "match" && row.match.nodeIdx >= 0) {
      const from = Math.max(0, row.match.nodeIdx - 2), to = Math.min(row.session.nodes.length, row.match.nodeIdx + 3);
      state.preview = row.session.nodes.slice(from, to).flatMap((node, offset) => node.kind === "assistant" ? (node.blocks ?? []).map((block) => ({ kind: block.kind, text: this.#searchBlockText(node, block), active: from + offset === row.match.nodeIdx && block === node.blocks?.[row.match.blockIdx] })) : [{ kind: node.kind, text: this.#searchBlockText(node), active: from + offset === row.match.nodeIdx }]);
    } else if (row?.session) state.preview = [{ kind: "text", text: row.session.snippet }];
    else state.preview = [];
    state.previewScroll = 0;
  }
  async #jumpSearchResult(row) {
    if (!row?.session) return;
    const sessionId = row.session.sessionId;
    const query = this.searchState?.query ?? "";
    this.searchSeq++;
    this.searchActive = false;
    this.searchState = null;
    await this.openSession(sessionId);
    this.setMode("chat");
    this.focus(this.chat);
    if (row.kind === "match" && row.match.approximate) {
      this.toast("Host \u627E\u5230\u8BE5\u4F1A\u8BDD\uFF0C\u4F46\u5728\u89E3\u6790\u9884\u7B97\u5185\u672A\u5B9A\u4F4D\u5230\u7CBE\u786E\u6B63\u6587\uFF1B\u5DF2\u6253\u5F00\u4F1A\u8BDD\u5C3E\u90E8");
    } else if (row.kind === "match" && row.match.nodeIdx >= 0) {
      const targetSeq = row.match.seq;
      let index = targetSeq == null ? row.match.nodeIdx : this.chat.nodes.findIndex((node) => node.firstSeq <= targetSeq && node.lastSeq >= targetSeq);
      for (let i = 0; index < 0 && this.chat.hasMore && i < 40; i++) {
        await this.chat.loadOlder(null, 80);
        index = this.chat.nodes.findIndex((node) => node.firstSeq <= targetSeq && node.lastSeq >= targetSeq);
      }
      if (index >= 0) {
        this.chat.jumpToNode(index);
        const block = this.chat.blockItems.findIndex((item) => item.nodeIdx === index && (row.match.blockIdx == null || item.blockIdx === row.match.blockIdx) && (row.match.kind !== "code" || item.kind === "code"));
        if (block >= 0) {
          const item = this.chat.blockItems[block];
          this.chat.blockSel = block;
          this.chat.cursorMode = "block";
          this.chat.cursor = { line: item.headerLine, col: 0 };
          this.chat.view.scrollY = Math.max(0, item.headerLine - 2);
          this.searchQuery = query || null;
          this.chat.queueRebuild();
        } else {
          this.toast("\u5DF2\u5B9A\u4F4D\u5230\u6D88\u606F\uFF0C\u4F46\u5339\u914D\u5757\u5F53\u524D\u4E0D\u53EF\u89C1");
        }
      } else {
        this.toast("\u5728\u5386\u53F2\u52A0\u8F7D\u9884\u7B97\u5185\u672A\u80FD\u5B9A\u4F4D\u8BE5\u5339\u914D\uFF1B\u5DF2\u6253\u5F00\u4F1A\u8BDD\u5C3E\u90E8");
      }
    }
    this.redraw();
  }
  #onSearchKey(ev) {
    const state = this.searchState;
    if (!state) return;
    if (ev.type === "key" && ev.name === "escape") {
      this.searchSeq++;
      this.searchActive = false;
      this.searchState = null;
      this.focus(this.chat);
      this.layout();
      return;
    }
    if (state.phase === "input") {
      if (ev.type === "key" && ev.name === "enter") {
        void this.#executeSearch();
        return;
      }
      this.searchInput.onKey(ev);
      return;
    }
    if (ev.type === "text" && graphemes(ev.text ?? "").length === 1) {
      const text = graphemes(ev.text)[0];
      ev = { type: "key", name: "char", key: text.toLowerCase(), text, ctrl: false, alt: false, shift: text !== text.toLowerCase() };
    }
    if (ev.type !== "key") return;
    if (ev.name === "char" && ev.key === "/" && !ev.ctrl) {
      state.phase = "input";
      this.searchInput.setValue(state.query);
      this.focus(this.searchInput);
      return;
    }
    if (ev.ctrl && (ev.name === "up" || ev.name === "down")) {
      state.previewScroll = Math.max(0, state.previewScroll + (ev.name === "up" ? -1 : 1));
      return;
    }
    if ((ev.name === "up" || ev.name === "down") && state.rows.length) {
      state.selected = wrapIndex(state.selected + (ev.name === "up" ? -1 : 1), state.rows.length);
      this.#updateSearchPreview();
      return;
    }
    const row = state.rows[state.selected];
    if (ev.name === "char" && ev.key === " " && !ev.ctrl && row && row.kind !== "match") {
      const key = row.key;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      this.#flattenSearchRows();
      return;
    }
    if (ev.name === "char" && (ev.key === "t" || ev.key === "b") && !ev.ctrl && !ev.shift) {
      const kind = ev.key === "t" ? "reasoning" : "tool";
      if (state.typeFold.has(kind)) state.typeFold.delete(kind);
      else state.typeFold.add(kind);
      this.#flattenSearchRows();
      return;
    }
    if (ev.name === "enter" && row) {
      if (row.kind === "match") void this.#jumpSearchResult(row);
      else {
        if (state.collapsed.has(row.key)) state.collapsed.delete(row.key);
        else state.collapsed.add(row.key);
        this.#flattenSearchRows();
      }
    }
  }
  #renderSearchBuffer(s) {
    const state = this.searchState;
    if (!state) return;
    s.fillRect(0, 0, s.w - 1, s.h - 1, " ", { bg: T.BG });
    const split = Math.max(24, Math.min(Math.floor(s.w * 0.36), 48));
    s.box(0, 0, s.w - 1, s.h - 1, { fg: T.BORDER2, bg: T.BG }, " \u8DE8\u4F1A\u8BDD\u641C\u7D22 \xB7 Enter \u6267\u884C \xB7 / \u7F16\u8F91 \xB7 t/b \u6298\u53E0\u7C7B\u578B \xB7 Ctrl+\u2191\u2193 \u9884\u89C8 ");
    s.vline(split, 1, s.h - 2, "\u2502", { fg: T.BORDER2 });
    this.searchInput.x = 2;
    this.searchInput.y = 1;
    this.searchInput.w = Math.max(8, s.w - 4);
    this.searchInput.render(s);
    let y = 3;
    if (state.phase === "input") {
      s.text(2, y++, "\u6267\u884C\u641C\u7D22\u524D\u4EC5\u663E\u793A\u5DE5\u4F5C\u533A / \u4F1A\u8BDD\u7ED3\u6784\uFF1B\u4E0D\u4F1A\u5B9E\u65F6\u626B\u63CF\u5386\u53F2\u3002", { fg: K2.FAINT });
      for (const group of this.sidebar.groups) {
        if (y >= s.h - 2) break;
        s.text(2, y++, truncate(`\u25BE ${group.title} (${group.sessions.length})`, split - 3), { fg: K2.DIM });
        for (const session of group.sessions) {
          if (y >= s.h - 2) break;
          s.text(4, y++, truncate(session.projections?.values?.title ?? session.sessionId.slice(0, 8), split - 5), { fg: K2.FAINT });
        }
      }
      return;
    }
    if (state.loading) {
      s.text(2, y, "\u6B63\u5728\u641C\u7D22 Host \u7D22\u5F15\u5E76\u89E3\u6790\u5019\u9009\u4F1A\u8BDD\u2026", { fg: K2.ACCENT });
      return;
    }
    if (state.error) s.text(2, y++, `\u641C\u7D22\u5931\u8D25: ${truncate(state.error, split - 8)}`, { fg: K2.ERR });
    if (state.fallback) s.text(2, y++, `Host \u641C\u7D22\u7D22\u5F15\u4E0D\u53EF\u7528\uFF1A\u5DF2\u672C\u5730\u626B\u63CF\u6700\u8FD1 20 \u4E2A\u4F1A\u8BDD\u7684\u8FD1\u671F\u5386\u53F2\uFF08${truncate(String(state.fallbackError ?? ""), Math.max(8, split - 30))}\uFF09`, { fg: K2.WARN });
    if (state.hasMore && state.rows.length) s.text(2, y++, "Host \u5019\u9009\u5DF2\u622A\u65AD\uFF0C\u8BF7\u7F29\u5C0F\u67E5\u8BE2", { fg: K2.WARN });
    const available = Math.max(1, s.h - y - 2), scroll = Math.max(0, Math.min(Math.max(0, state.rows.length - available), state.selected - Math.floor(available / 2)));
    for (let i = 0; i < available; i++) {
      const index = scroll + i, row = state.rows[index];
      if (!row) break;
      const selected = index === state.selected, folded = state.collapsed.has(row.key);
      const label = row.kind === "workspace" ? `${folded ? "\u25B8" : "\u25BE"} ${row.group.title}` : row.kind === "session" ? `  ${folded ? "\u25B8" : "\u25BE"} ${row.session.title}` : `    ${selected ? "=>" : "  "} [${row.match.kind}] ${row.match.text.replace(/\s+/g, " ")}`;
      s.text(1, y + i, truncate(label, split - 2), { fg: selected ? T.SELFG : row.kind === "match" ? K2.TXT : K2.DIM, bg: selected ? T.MENUSEL : -1, attrs: selected ? 1 : 0 });
    }
    let py = 3, logical = 0;
    for (const item of state.preview) {
      if (state.typeFold.has(item.kind)) continue;
      const wrapped = wrapDisplayText(item.text || "\uFF08\u7A7A\uFF09", Math.max(10, s.w - split - 5));
      for (const line of wrapped) {
        if (logical++ < state.previewScroll) continue;
        if (py >= s.h - 2) break;
        s.text(split + 2, py++, truncate(`${item.active ? "=>" : "  "} [${item.kind}] ${line}`, s.w - split - 4), { fg: item.active ? T.ACCENT : K2.TXT, attrs: item.active ? 1 : 0 });
      }
      if (py >= s.h - 2) break;
    }
    if (!state.rows.length) s.text(2, y, state.error ? `\u641C\u7D22\u5931\u8D25: ${state.error}` : state.fallback ? "\u672C\u5730\u626B\u63CF\u6CA1\u6709\u5339\u914D\uFF08\u4EC5\u6700\u8FD1 20 \u4E2A\u4F1A\u8BDD\u7684\u8FD1\u671F\u5386\u53F2\uFF09" : state.hasMore ? "\u7ED3\u679C\u8D85\u8FC7 Host \u4E0A\u9650\uFF0C\u8BF7\u7F29\u5C0F\u67E5\u8BE2" : "\u6CA1\u6709\u5339\u914D", { fg: state.error ? K2.BAD : K2.FAINT });
  }
  redraw() {
    this.dirty = true;
  }
  // ---- main loop ----
  run() {
    const tick = () => {
      try {
        if (this.dirty) {
          this.dirty = false;
          this.renderFrame();
        }
        if (this.toastMsg && Date.now() > this.toastUntil) {
          this.toastMsg = null;
          this.dirty = true;
        }
        const sec = Math.floor(Date.now() / 1e3);
        if (sec !== this.lastSec) {
          this.lastSec = sec;
          if (this.chat.running) this.chat.queueRebuild();
          this.dirty = true;
        }
      } catch (e) {
        this.log("render error (kept running):", e);
        try {
          const dir = stateRoot();
          (0, import_node_fs7.mkdirSync)(dir, { recursive: true });
          (0, import_node_fs7.appendFileSync)((0, import_node_path7.join)(dir, "tui-error.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${e?.stack ?? e}
`);
        } catch {
        }
        try {
          this.term?.output?.write?.(this.screen.render());
        } catch {
        }
        this.dirty = true;
      }
      this.timer = setTimeout(tick, 33);
    };
    tick();
  }
  /** Force one render (also used by the scripted test harness). */
  renderFrame() {
    this.chat.flushRebuild();
    const s = this.screen;
    s.clear(-1, T.BG);
    if (this.tooSmall) {
      const msg = "\u7EC8\u7AEF\u8FC7\u5C0F\uFF0C\u81F3\u5C11\u9700\u8981 20\xD76";
      s.text(Math.max(0, Math.floor((s.w - strWidth(msg)) / 2)), Math.max(0, Math.floor(s.h / 2)), truncate(msg, s.w), { fg: T.WARN });
      this.term.output.write(s.render() + "\x1B[?25l");
      return;
    }
    if (this.searchActive && this.searchState) {
      this.#renderSearchBuffer(s);
      this.term.output.write(s.render() + "\x1B[?25l");
      return;
    }
    if (this.fullBuffer) {
      this.fullBuffer.relayout(0, 0, s.w, s.h);
      this.fullBuffer.render(s);
      if (this.popup) this.popup.render(s);
      if (this.menu) this.menu.render(s);
      if (this.overlay) this.overlay.render(s);
      this.#renderToast(s);
      this.term.output.write(s.render() + "\x1B[?25l");
      return;
    }
    this.#renderTabBar(s);
    if (this.sidebarVisible) {
      this.sidebar.y = 0;
      this.sidebar.h = s.h - 1;
      this.sidebar.render(s);
      s.put(this.sidebar.w - 1, 0, "\u2502", { fg: T.BORDER });
      for (let y = 1; y < s.h - 1; y++) s.put(this.sidebar.w - 1, y, "\u2502", { fg: T.BORDER });
    }
    const modePanel = this.panelForMode();
    if (modePanel) modePanel.render(s);
    else this.chat.render(s);
    const t = this.titleOf();
    const cur = this.sessions.find((x) => x.sessionId === this.currentSession);
    const ws = this.sessions.length ? this.projections?.values?.title ? "" : "" : "";
    const footerH = this.footerHeight();
    const rows = [];
    const row0 = { left: [], right: [] };
    const editing = this.focused === this.chat?.input;
    row0.left.push({ t: editing ? " INSERT " : " NORMAL ", fg: editing ? T.OK : T.FAINT, bg: T.STATUSBG, bold: editing });
    row0.left.push({ t: " Ctrl+Space \u9762\u677F ", fg: T.DIM, bg: T.STATUSBG });
    const perm = this.projections.permissions?.currentValue;
    const preset = this.sessions.find((s2) => s2.sessionId === this.currentSession)?.agentPreset;
    const badge = perm && preset ? `${permName(perm)}/${modeName(preset)}` : perm ? permName(perm) : preset ? modeName(preset) : "\u672A\u9009\u4F1A\u8BDD";
    row0.left.push({ t: ` ${badge} `, fg: T.SELFG, bg: T.ACCENT, bold: true });
    const rawGoal = this.goalData?.goal ?? this.goalData;
    if (rawGoal && !["complete", "completed", "cleared"].includes(rawGoal.phase)) {
      row0.left.push({ t: ` \u{1F3AF} ${truncate(rawGoal.objective ?? "\u76EE\u6807", 14)} \xB7 Ctrl+G `, fg: 0, bg: T.WARN, bold: true });
    }
    if (this.sidebarVisible) row0.left.push({ t: " " + truncate(t || "\uFF08\u672A\u9009\u62E9\u4F1A\u8BDD\uFF09", 40) + " ", fg: T.TXT, bg: T.STATUSBG });
    else row0.left.push({ t: " " + truncate(t || "\uFF08\u672A\u9009\u62E9\u4F1A\u8BDD\uFF09", 40) + " ", fg: T.TXT, bg: T.STATUSBG });
    if (cur?.running) row0.left.push({ t: " \u25CF\u8FD0\u884C ", fg: T.OK, bg: T.STATUSBG });
    {
      const stats2 = this.projections.sessionStats ?? cur?.projections?.values?.sessionStats;
      const startMs = this.chat?.earliestTime;
      const parts = [];
      if (stats2 && stats2.llmMs != null) parts.push(`\u6709\u6548 ${fmtDuration(stats2.llmMs + (stats2.toolMs ?? 0))}`);
      if (startMs != null) parts.push(`\u5F00\u59CB ${fmtDateTime(startMs)}`);
      if (parts.length) row0.left.push({ t: ` ${parts.join(" \xB7 ")} `, fg: T.DIM, bg: T.STATUSBG });
    }
    const plan = this.projections.plan;
    if (plan?.active || plan?.pending) row0.right.push({ t: plan.active ? " \u270E\u8BA1\u5212\u4E2D " : " \u270E\u8BA1\u5212\u5F85\u5BA1 ", fg: T.SELFG, bg: T.ACCENT2 });
    const m = this.currentModel;
    const modelLabel = m ? `${m.provider}/${m.model}${m.reasoningEffort ? `@${m.reasoningEffort}` : ""}` : `${this.provider}/${this.model}`;
    row0.right.push({ t: ` ${modelLabel} `, fg: T.DIM, bg: T.STATUSBG });
    if (this.connState === "disconnected") row0.right.push({ t: " \u26A0\u79BB\u7EBF ", fg: T.SELFG, bg: T.ERR, bold: true });
    else if (this.connState === "degraded" || this.connState === "connecting") row0.right.push({ t: " \u26A0\u90E8\u5206\u79BB\u7EBF ", fg: T.SELFG, bg: T.WARN, bold: true });
    rows.push(row0);
    const row1 = { left: [], right: [] };
    const ctx = this.projections.contextPressure;
    if (ctx && ctx.contextWindow) {
      const pct = Math.round(100 * ctx.pressureTokens / ctx.contextWindow);
      const color = pct > 90 ? T.ERR : pct > 60 ? T.WARN : T.OK;
      const meter = bars(Array(10).fill(ctx.pressureTokens / ctx.contextWindow), 10);
      row1.left.push({ t: " " + meter + " ", fg: color, bg: T.STATUSBG });
      row1.left.push({ t: ` ctx ${pct}% ${fmtTokens(ctx.pressureTokens)}/${fmtTokens(ctx.contextWindow)} `, fg: color, bg: T.STATUSBG });
    }
    const tu = this.projections.tokenUsage ?? this.tokenUsage;
    if (tu) {
      const out2 = tu.outputTokens ?? 0;
      const cacheRead = tu.cacheReadTokens ?? 0;
      const cache2 = cacheRead + (tu.cacheWriteTokens ?? 0);
      const uncached = tu.uncachedInputTokens ?? 0;
      const total = out2 + cache2 + uncached;
      row1.right.push({ t: ` \u5165 ${fmtTokens(uncached)} `, fg: T.DIM, bg: T.STATUSBG });
      row1.right.push({ t: ` \u51FA ${fmtTokens(out2)} `, fg: T.OK, bg: T.STATUSBG });
      row1.right.push({ t: ` \u7F13\u5B58 ${fmtTokens(cache2)} `, fg: T.ACCENT, bg: T.STATUSBG });
      const hit = total > 0 ? Math.round(100 * cacheRead / total) : 0;
      row1.right.push({ t: ` \u547D\u4E2D${hit}% `, fg: T.FAINT, bg: T.STATUSBG });
      row1.right.push({ t: ` \u5171 ${fmtTokens(total)} `, fg: T.BOLD, bg: T.STATUSBG, bold: true });
    }
    const cwd = this.currentSession ? this.sessions.find((x) => x.sessionId === this.currentSession)?.cwd : process.cwd();
    if (cwd) row1.left.push({ t: ` ${cwd} `, fg: T.FAINT, bg: T.STATUSBG });
    row1.left.push({ t: ` ${fmtClock(Date.now())} `, fg: T.DIM, bg: T.STATUSBG });
    const stats = this.projections.sessionStats;
    if (stats) {
      if (stats.steps) row1.right.push({ t: ` \u2699${stats.steps}\u6B65 `, fg: T.FAINT, bg: T.STATUSBG });
      if (stats.turns) row1.right.push({ t: ` ${stats.turns}\u56DE\u5408 `, fg: T.FAINT, bg: T.STATUSBG });
      if (stats.ttftMs && stats.ttftSteps) row1.right.push({ t: ` \u9996\u54CD${Math.round(stats.ttftMs / stats.ttftSteps)}ms `, fg: T.FAINT, bg: T.STATUSBG });
      if (stats.decodeMs && stats.decodeTokens) row1.right.push({ t: ` \u89E3\u7801${Math.round(1e3 * stats.decodeTokens / stats.decodeMs)}tok/s `, fg: T.FAINT, bg: T.STATUSBG });
    }
    rows.push(row1);
    {
      const c = this.chat;
      const below = c.lines.length - 1 - (c.view.scrollY + c.view.h);
      if (!c.view.follow && below > 0) {
        row1.left.push({ t: ` \u2193${below} \u6761\u65B0\u5185\u5BB9 \xB7 G \u8DDF\u968F `, fg: T.SELFG, bg: T.ACCENT, bold: true });
      }
    }
    {
      const jobs = this.jobs ?? [];
      const running = jobs.filter((j) => j.status === "running").length;
      const done = jobs.filter((j) => j.status === "completed").length;
      const failed = jobs.filter((j) => j.status === "failed").length;
      const row2 = { left: [], right: [] };
      const sub = this.projections.subagent;
      const subTiming = this.projections.subagentTiming;
      const subStats = this.subagentStatsBySession.get(this.currentSession) ?? { running: subTiming?.active ? 1 : 0, completed: 0 };
      row2.left.push({
        t: ` ${running > 0 ? `${running} \u4E2A\u540E\u53F0\u4EFB\u52A1\u8FD0\u884C\u4E2D` : "\u6CA1\u6709\u540E\u53F0\u4EFB\u52A1\u8FD0\u884C"} `,
        fg: running > 0 ? T.WARN : T.FAINT,
        bg: T.STATUSBG,
        bold: running > 0
      });
      row2.left.push({
        t: ` ${done}\u5DF2\u5B8C\u6210${failed > 0 ? ` \xB7 ${failed}\u5931\u8D25` : ""} `,
        fg: done > 0 ? T.OK : failed > 0 ? T.WARN : T.FAINT,
        bg: T.STATUSBG
      });
      row2.left.push({
        t: ` ${subStats.running > 0 ? `${subStats.running} \u4E2A\u5B50\u4EE3\u7406\u8FD0\u884C\u4E2D` : "\u6CA1\u6709\u5B50\u4EE3\u7406\u8FD0\u884C"} `,
        fg: subStats.running > 0 ? T.WARN : T.FAINT,
        bg: T.STATUSBG,
        bold: subStats.running > 0
      });
      row2.left.push({
        t: ` ${subStats.completed}\u5DF2\u5B8C\u6210 `,
        fg: subStats.completed > 0 ? T.OK : T.FAINT,
        bg: T.STATUSBG
      });
      row2.left.push({ t: " Ctrl+J \u4EFB\u52A1/\u5B50\u4EE3\u7406 ", fg: T.DIM, bg: T.STATUSBG });
      if (sub) row2.left.push({
        t: ` \u25C7 ${truncate(sub.label ?? sub.mode ?? "\u5B50\u4EE3\u7406", 20)} `,
        fg: subStats.running > 0 ? T.WARN : subStats.completed > 0 ? T.OK : T.FAINT,
        bg: T.STATUSBG
      });
      if (this.queueItems.length) row2.left.push({ t: ` \u6709${this.queueItems.length}\u6761\u547D\u4EE4\u6B63\u5728\u6392\u961F Ctrl+N\u67E5\u770B\u8BE6\u60C5 `, fg: 0, bg: T.WARN, bold: true });
      rows.push(row2);
    }
    this.status.rows = rows;
    this.status.render(s);
    if (this.popup) this.popup.render(s);
    if (this.menu) this.menu.render(s);
    if (this.overlay) this.overlay.render(s);
    this.#renderToast(s);
    if (this.renameInput && this.popup) this.renameInput.render(s);
    const out = s.render();
    let tail = "";
    if (this.overlay && typeof this.overlay.kittyTransmit === "function" && kittyCapable()) {
      tail = this.overlay.kittyTransmit();
    }
    const cell = this.focused?.cursorCell;
    if (cell) tail = tail + `\x1B[?25h\x1B[${cell.y + 1};${cell.x + 1}H`;
    else tail = tail + "\x1B[?25l";
    this.term.output.write(out + tail);
  }
  #renderToast(s) {
    if (!this.toastMsg) return;
    const w = Math.min(s.w - 4, strWidth(this.toastMsg) + 6);
    const x0 = Math.max(2, Math.floor((s.w - w) / 2));
    const y = Math.max(1, this.chat.input.y - this.chat.todoHeight() - 2);
    s.fillRect(x0, y, x0 + w - 1, y, " ", { bg: T.ACCENT });
    s.text(x0 + 1, y, truncate(this.toastMsg, w - 2), { fg: T.SELFG, bg: T.ACCENT, attrs: 1 });
  }
  titleOf() {
    const s = this.sessions.find((x) => x.sessionId === this.currentSession);
    if (s) return s.projections?.values?.title ?? s.sessionId.slice(0, 8);
    return "\uFF08\u672A\u9009\u62E9\u4F1A\u8BDD\uFF09";
  }
  stop(exit = true) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.timer) clearTimeout(this.timer);
    this.pollTimer = this.timer = null;
    this.term.stop();
    this.api.closeStreams();
    this.cache.close();
    if (exit) {
      this.api.close();
      process.exit(0);
    }
  }
};

// vendor/dsh-neotui/src/login.js
function createLoginForm(api) {
  const email = new Input({ prompt: "Email: ", placeholder: "you@example.com" });
  const password = new Input({ prompt: "Password: ", masked: true });
  return {
    email,
    password,
    async submit() {
      const emailValue = email.value;
      const passwordValue = password.value;
      email.setValue("");
      password.setValue("");
      return api.login(emailValue, passwordValue);
    }
  };
}
function promptLogin({ api, screen, term, setEventHandler }) {
  return new Promise((resolve2) => {
    let active = "email";
    let error = "";
    let submitting = false;
    const form = createLoginForm(api);
    const { email, password } = form;
    const width = Math.max(28, Math.min(64, screen.w - 8));
    const left = Math.max(2, Math.floor((screen.w - width) / 2));
    email.x = password.x = left;
    email.w = password.w = width;
    const render = () => {
      screen.clear(-1, T.BG);
      const top = Math.max(1, Math.floor(screen.h / 2) - 4);
      email.x = password.x = left;
      email.y = top + 2;
      password.y = top + 4;
      screen.text(left, top, truncate("DSH Login", width), { fg: T.ACCENT, attrs: 1 });
      screen.text(left, top + 1, "\u2500".repeat(Math.max(1, width - 1)), { fg: T.BORDER });
      email.render(screen);
      password.render(screen);
      const hint = submitting ? "Signing in..." : "Enter submit \xB7 Tab switch \xB7 Ctrl+C exit";
      screen.text(left, top + 6, truncate(hint, width), { fg: T.FAINT });
      if (error) screen.text(left, top + 7, truncate(error, width), { fg: T.ERR });
      const cursor = (active === "email" ? email : password).cursorCell;
      const move = cursor ? `\x1B[${cursor.y + 1};${cursor.x + 1}H\x1B[?25h` : "\x1B[?25l";
      term.output.write(screen.render() + move);
    };
    const submit = async () => {
      if (submitting) return;
      submitting = true;
      error = "";
      render();
      try {
        await form.submit();
        resolve2();
      } catch (cause) {
        error = cause.message;
        submitting = false;
        active = "email";
        render();
      }
    };
    email.onEnter = () => {
      active = "password";
      render();
    };
    password.onEnter = submit;
    setEventHandler((event) => {
      if (event.type === "key" && event.ctrl && event.key === "c") {
        term.stop();
        process.exit(0);
      }
      if (event.type === "key" && event.name === "tab") {
        active = active === "email" ? "password" : "email";
        render();
        return;
      }
      if (!submitting) (active === "email" ? email : password).onKey(event);
      render();
    });
    render();
  });
}

// vendor/dsh-neotui/bin/dsh-tui.js
var import_node_fs8 = require("node:fs");
var VERSION = true ? "1.0.0" : "development";
var log = (...a) => console.error("[dsh-tui]", ...a);
var activeTerm = null;
async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText(VERSION));
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}
`);
    return;
  }
  process.env.DSH_URL = options.base;
  process.env.DSH_TUI_WORKSPACE = options.workspace;
  if (options.cache) process.env.DSH_TUI_CACHE_HOME = options.cache;
  if (options.resume) process.env.DSH_TUI_RESUME_SESSION = options.resume;
  if (options.check) {
    const result = await gatewayPreflight(options.base);
    process.stdout.write(`${JSON.stringify({ ...result, workspace: options.workspace, cache: options.cache ?? "default", authenticationAttempted: false }, null, 2)}
`);
    return;
  }
  if (options.script) {
    await runScripted(options.script, options.plain, options.base);
    return;
  }
  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24);
  const api = new Api({ base: options.base, log, onFrame: () => {
  }, onHostFrame: () => {
  } });
  let handler = () => {
  };
  const term = new Term({
    output: process.stdout,
    kitty: detectKitty(),
    onEvent: (ev) => handler(ev),
    onResize: (w, h) => {
      screen.resize(w, h);
      currentApp?.resize(w, h);
    }
  });
  let currentApp = null;
  activeTerm = term;
  screen.resize(term.w, term.h);
  term.start();
  const startAuthenticatedApp = async () => {
    await promptLogin({ api, screen, term, setEventHandler: (next) => {
      handler = next;
    } });
    const app = new App({ screen, term, api, log });
    currentApp = app;
    app.onAuthRequired = async () => {
      currentApp = null;
      api.closed = false;
      term.start();
      await startAuthenticatedApp();
    };
    api.onAuthRequired = () => {
      app.stop(false);
      app.onAuthRequired();
    };
    handler = (ev) => app.onEvent(ev);
    app.resize(term.w, term.h);
    if (!await app.init()) return;
    app.redraw();
    app.run();
  };
  process.on("SIGINT", () => currentApp?.stop());
  process.on("SIGTERM", () => currentApp?.stop());
  await startAuthenticatedApp();
}
var FakeOutput = class {
  constructor() {
    this.chunks = [];
    this.columns = 100;
    this.rows = 30;
  }
  write(s) {
    this.chunks.push(s);
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
};
async function runScripted(scriptFile, plain, base) {
  const out = new FakeOutput();
  const screen = new Screen(100, 30);
  const api = new Api({ base, log, onFrame: () => {
  }, onHostFrame: () => {
  } });
  const app = new App({ screen, term: { output: out, write: (s) => out.write(s) }, api, log });
  const events = (0, import_node_fs8.readFileSync)(scriptFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!api.auth.authenticated) throw new Error("scripted mode requires an authenticated Api test harness");
  await app.init();
  app.renderFrame();
  dump(app, plain);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let quit = false;
  for (const line of events) {
    if (quit) break;
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "wait":
        await sleep(Number(rest[0] ?? 100));
        break;
      case "quit":
        quit = true;
        break;
      case "key": {
        const [name, mods] = rest;
        const ev = { type: "key", name, ctrl: false, alt: false, shift: false, key: name, text: name };
        if (mods?.includes("c")) {
          ev.ctrl = true;
          ev.key = name;
          ev.text = name;
        }
        app.onEvent(ev);
        break;
      }
      case "text":
        app.onEvent({ type: "text", text: line.slice(5) });
        break;
      case "space":
        app.onEvent({ type: "text", text: " " });
        break;
      case "mouse": {
        const [kind, btn, x, y] = rest;
        app.onEvent({ type: "mouse", kind, button: Number(btn ?? 0), x: Number(x ?? 0), y: Number(y ?? 0), ctrl: false, shift: false, alt: false, motion: false });
        break;
      }
      case "resize": {
        const [w, h] = rest.map(Number);
        app.resize(w, h);
        break;
      }
      case "frame":
        app.injectFrame(JSON.parse(line.slice(6)));
        break;
      default:
        log(`unknown script cmd: ${cmd}`);
    }
    await sleep(30);
    app.renderFrame();
    dump(app, plain);
  }
  api.close();
  await sleep(100);
  process.exit(0);
}
function dump(app, plain) {
  const screen = app.screen;
  const out = app.term.output;
  if (plain) {
    console.log("\u2500\u2500\u2500\u2500\u2500 frame \u2500\u2500\u2500\u2500\u2500");
    console.log(screen.toPlain());
  } else {
    console.log("\u2500\u2500\u2500\u2500\u2500 frame \u2500\u2500\u2500\u2500\u2500");
    console.log(out.toString().replace(/\x1b/g, "<ESC>"));
  }
  out.chunks.length = 0;
}
main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(`dsh-client: ${error.message}
Run dsh-client --help for usage.`);
  } else {
    log("fatal:", error?.message ?? error);
  }
  try {
    activeTerm?.stop();
  } catch {
  }
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
});
