var Duplex = require('stream').Duplex

var inherits    = require('inherits')
var Telegram    = require('telegram-bot-api')
var WebhookPost = require('webhook-post')


/**
 * Send data as messages to a Telegram chat
 *
 * @class
 *
 * @param {string} token
 * @param {string} chat_id
 * @param {Object} [options]
 * @param {string|Object|80|88|443|8443} [options.webhook={}]
 * @param {string} [options.webhook.hostname='0.0.0.0']
 * @param {80|88|443|8443} [options.webhook.port]
 * @param {string} [options.webhook.certificate='']
 * @param {string} [options.certificate='']
 *
 * @emits TelegramLog#data
 * @emits TelegramLog#error
 * @emits Readable#end
 */
function TelegramLog(token, chat_id, options)
{
  if(!(this instanceof TelegramLog))
    return new TelegramLog(token, chat_id, options)

  var self = this

  if(token.constructor.name === 'Object')
  {
    chat_id = token.chat_id
    options = token.options

    token = token.token
  }

  options = options || {}
  options.objectMode = true

  TelegramLog.super_.call(this, options)


  if(!token)   throw 'Missing token'
  if(!chat_id) throw 'Missing chat_id'

  var _updatesOffset = 0

  var api = new Telegram({token: token})


  //
  // Private functions
  //

  /**
   * @param {string} message
   * @param {*} data
   */
  function emitError(message, data)
  {
    var error = new Error(message)
        error.data = data

    self.emit('error', error)
  }

  /**
   * Process a single received Telegram `Update` object
   *
   * @param {Object} update
   *
   * @return Boolean - more `Update` objects can be fetch
   */
  function processUpdate(update)
  {
    // Account update_id as next offset
    // to avoid dublicated updates
    var update_id = update.update_id
    if(update_id >= _updatesOffset)
      _updatesOffset = update_id + 1

    // Check the update is from a text message from our chat
    var message = update.message
    if(message == null)
      return emitError('Inline queries are not supported', update)

    if(message.chat.id !== chat_id)
      return emitError('Received message for not-listening chat', message)

    var text = message.text
    if(text == null)
      return emitError('Only text messages are supported', message)

    // Everything is allright, push the data
    return self.push(message.text)
  }

  var end = this.push.bind(this, null)


  //
  // Webhook
  //

  var webhook = options.webhook
  if(webhook)
  {
    /**
     * Close the webhook and set it as finished
     */
    function closeWebhook()
    {
      webhook.close()
      webhook = null
    }

    if(typeof webhook !== 'string')
    {
      // Telegram only support ports 80, 88, 443 and 8443
      var port = webhook.port || webhook

      if(port !== 80 && port !== 88 && port !== 443 && port !== 8443)
      {
        var error = new RangeError('Port must be one of 80, 88, 443 or 8443')
            error.port = port

        throw error
      }
    }

    var certificate = webhook.certificate || options.certificate || ''

    // Create webhook
    webhook = WebhookPost(webhook, options)
    .on('open', function(url)
    {
      api
      .setWebhook({url: url, certificate: certificate})
      .catch(function(error)
      {
        self.emit('error', error)

        webhook = null
        end()
      })
    })
    .on('data', function(data)
    {
      var update = JSON.parse(data)

      // Ignore duplicated updates
      if(update.update_id >= _updatesOffset) processUpdate(update)
    })
    .on('error', this.emit.bind(this, 'error'))
    .on('end', function()
    {
      if(!webhook) return end()
      webhook = null

      api.setWebhook({certificate: certificate}).then(end, end)
    })
  }


  //
  // Polling
  //

  var polling
  var inFlight

  /**
   * Process a Telegram `Update` object and check if it should do more requests
   *
   * @param {Boolean} fetchMoreDate
   * @param {Object} update
   *
   * @return Boolean - more `Update` objects can be fetch
   */
  function processUpdate_reduce(fetchMoreDate, update)
  {
    return processUpdate(update) && fetchMoreDate
  }

  /**
   * Process received Telegram `Update` objects and queue a new polling request
   *
   * @param {Array} data
   */
  function gotUpdates(data)
  {
    inFlight = false

    if(data.reduce(processUpdate_reduce, true)) setTimeout(self._read, 1000)
  }

  /**
   * Emit an error when requesting updates and free `inFlight` flag
   *
   * @param {Error} error
   */
  function onError(error)
  {
    inFlight = false

    self.emit('error', error)
  }


  /**
   * Request new updates. This will not work when using a webhook
   *
   * @private
   */
  this._read = function()
  {
    var state = self._readableState
    var limit = state.highWaterMark - state.length

    if(inFlight || state.ended || !limit
    || polling === null || webhook !== undefined)
      return

    inFlight = true

    polling = api.getUpdates({
      offset: _updatesOffset,
      limit: limit,
      timeout: 0
    })
    .then(gotUpdates)
    .catch(onError)
  }


  //
  // Duplex API
  //

  /**
   * Write a data message
   *
   * @param {Object} chunk
   * @param {*} _ - ignored
   * @param {Function} done
   *
   * @private
   */
  this._write = function(chunk, _, done)
  {
    if(chunk == null || chunk == '') return done()

    api.sendMessage(
    {
  		chat_id: chat_id,
  		text: JSON.stringify(chunk)
  	})
    .then(done.bind(null, null), done)
  }


  //
  // Public API
  //

  /**
   * Close the connection and stop emitting more data updates
   */
  this.close = function()
  {
    if(webhook === null) return

    if(webhook)
      return api.setWebhook({certificate: certificate})
      .then(closeWebhook, closeWebhook)

    if(polling)
    {
      polling.then(end, end)
      polling = null
    }
  }
}
inherits(TelegramLog, Duplex)


/**
 * @event TelegramLog#data
 *
 * @type {string}
 */

/**
 * @event TelegramLog#error
 *
 * @type {Error}
 */


module.exports = TelegramLog
