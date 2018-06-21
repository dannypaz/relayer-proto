const {
  Order,
  FeeInvoice,
  DepositInvoice,
  FeeRefundInvoice,
  DepositRefundInvoice,
  Invoice,
  Fill } = require('../models')
const { PublicError } = require('../errors')
/**
 * Given an fillId and refundInvoice, fill the order in the relayer. This will
 * award the fill to the user and start the execution process
 *
 * @param {GrpcUnaryMethod~request} request - request object
 * @param {Object} request.params - Request parameters from the client
 * @param {Object} request.logger - logger for messages about the method
 * @param {EventEmitter} request.eventHandler - Event bus to put order messages onto
 * @param {Object} request.engine - Lightning Network engine
 * @param {Object} responses
 * @param {function} responses.CreateFillResponse - constructor for CreateFillResponse messages
 * @return {responses.CreateFillResponse}
 */

const FRIENDLY_ERRORS = {
  INSUFFICIENT_FUNDS_OUTBOUND: id => `Outbound channel does not have sufficient balance. Order id: ${id}`,
  INSUFFICIENT_FUNDS_INBOUND: id => `Inbound channel does not have sufficient balance. Order id: ${id}`,
  ORDER_NOT_PLACED: id => `Order is not in a placed status, refunds have been executed. Order id: ${id}`,
  FEE_VALUES_UNEQUAL: id => `Fee Invoice Refund value is not the same as Fee Invoice value. Order id: ${id}`,
  DEPOSIT_VALUES_UNEQUAL: id => `Deposit Invoice Refund value is not the same as Deposit Invoice value. Order id: ${id}`
}

async function fillOrder ({ params, logger, messenger, engine }) {
  const { fillId, feeRefundPaymentRequest, depositRefundPaymentRequest } = params

  const fill = await Fill.findOne({ fillId })
  // TODO: validate ownership of the fill
  if (!fill) throw new Error(`No fill with ID ${fillId}.`)

  const order = await Order.findOne({ _id: fill.order_id })
  if (!order) throw new Error(`No order associated with fill ${fill.fillId}.`)

  const {feeInvoice, depositInvoice} = await invoicesForFill(fill._id)
  const [feeInvoicePaid, depositInvoicePaid] = await Promise.all([
    engine.isInvoicePaid(feeInvoice.paymentRequest),
    engine.isInvoicePaid(depositInvoice.paymentRequest)
  ])

  if (!feeInvoicePaid) throw new Error(`Fee Invoice for Order ${order.orderId} has not been paid.`)
  if (!depositInvoicePaid) throw new Error(`Deposit Invoice for Order ${order.orderId} has not been paid.`)

  const [feeValue, feeRefundValue] = await Promise.all([
    engine.getInvoiceValue(feeInvoice.paymentRequest),
    engine.getInvoiceValue(feeRefundPaymentRequest)
  ])

  if (feeValue !== feeRefundValue) {
    logger.error('Fee invoice refund amount does not equal fee invoice amount', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.FEE_VALUES_UNEQUAL(order.orderId))
  }

  const [depositValue, depositRefundValue] = await Promise.all([
    engine.getInvoiceValue(depositInvoice.paymentRequest),
    engine.getInvoiceValue(depositRefundPaymentRequest)
  ])

  if (depositValue !== depositRefundValue) {
    logger.error('Deposit invoice refund amount does not equal deposit invoice amount', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.DEPOSIT_VALUES_UNEQUAL(order.orderId))
  }

  const { feeRefundInvoice, depositRefundInvoice } = await createRefundInvoices(fill._id, feeRefundPaymentRequest, depositRefundPaymentRequest)
  logger.info('Refund invoices have been stored on the Relayer', {
    deposit: depositRefundInvoice._id,
    fee: feeRefundInvoice._id
  })

  await checkChannelBalances(order, fill, engine, logger)

  // TODO: refund their payments if the order is no longer in a good status?
  if (order.status !== Order.STATUSES.PLACED) {
    const [feePreimage, depositPreimage] = await Promise.all([
      engine.payInvoice(feeRefundPaymentRequest),
      engine.payInvoice(depositRefundPaymentRequest)
    ])

    await feeRefundInvoice.markAsPaid(feePreimage)
    await depositRefundInvoice.markAsPaid(depositPreimage)

    throw new PublicError(FRIENDLY_ERRORS.ORDER_NOT_PLACED(order.orderId))
  }

  await fill.accept()
  await order.fill()

  // note that the order does not get officially filled until `subscribeFill` takes it.
  await messenger.set(`fill:${order._id}`, fill.fillId)
  logger.info('order:filling', { orderId: order.orderId })

  return {}
}

/**
 * Given id of the fill find the corresponding fee and deposit invoices
 * @param {String} _fillId this is the fill._id
 * @return {Object<feeInvoice, depositInvoice>}
 */
async function invoicesForFill (_fillId) {
  const feeInvoice = await FeeInvoice.findOne({
    foreignId: _fillId,
    foreignType: Invoice.FOREIGN_TYPES.FILL,
    type: Invoice.TYPES.INCOMING,
    purpose: Invoice.PURPOSES.FEE
  })

  const depositInvoice = await DepositInvoice.findOne({
    foreignId: _fillId,
    foreignType: Invoice.FOREIGN_TYPES.FILL,
    type: Invoice.TYPES.INCOMING,
    purpose: Invoice.PURPOSES.DEPOSIT
  })

  if (!feeInvoice) {
    throw new Error(`Could not find fee invoice associated with Fill ${_fillId}.`)
  }
  if (!depositInvoice) {
    throw new Error(`Could not find deposit invoice associated with Fill ${_fillId}.`)
  }

  return { feeInvoice, depositInvoice }
}

/**
 * Given id of the fill, and the refund payment request hashes, create the refund invoices
 * @param {String} _fillId
 * @param {String} feeRefundPaymentRequest
 * @param {String} depositRefundPaymentRequest
 * @return {Object<feeRefundInvoice, depositRefundInvoice>}
 */
async function createRefundInvoices (_fillId, feeRefundPaymentRequest, depositRefundPaymentRequest) {
  const feeRefundInvoice = await FeeRefundInvoice.create({
    foreignId: _fillId,
    foreignType: Invoice.FOREIGN_TYPES.FILL,
    paymentRequest: feeRefundPaymentRequest,
    type: Invoice.TYPES.OUTGOING,
    purpose: Invoice.PURPOSES.FEE
  })
  const depositRefundInvoice = await DepositRefundInvoice.create({
    foreignId: _fillId,
    foreignType: Invoice.FOREIGN_TYPES.FILL,
    paymentRequest: depositRefundPaymentRequest,
    type: Invoice.TYPES.OUTGOING,
    purpose: Invoice.PURPOSES.DEPOSIT
  })

  return { feeRefundInvoice, depositRefundInvoice }
}

/**
 * Given the order and fill, validate that the channels have sufficient funds to fill the order
 *
 * @param {Object} order
 * @param {Object} fill
 * @param {Object} engine - Lightning Network engine
 * @param {Object} logger
 * @return {Void}
 */
async function checkChannelBalances (order, fill, engine, logger) {
  const [sufficientBalanceInOutboundChannelMaker, sufficientBalanceInInboundChannelMaker,
    sufficientBalanceInOutboundChannelTaker, sufficientBalanceInInboundChannelTaker] = await Promise.all([
    engine.isBalanceSufficient(order.payTo.slice(3), order.counterAmount, {outbound: true}),
    engine.isBalanceSufficient(order.payTo.slice(3), order.baseAmount, {outbound: false}),
    engine.isBalanceSufficient(fill.takerPayTo.slice(3), order.counterAmount, {outbound: true}),
    engine.isBalanceSufficient(fill.takerPayTo.slice(3), order.baseAmount, {outbound: false})
  ])

  if (!sufficientBalanceInOutboundChannelMaker) {
    logger.error('Insufficient funds in outbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_OUTBOUND(order.orderId))
  }

  if (!sufficientBalanceInInboundChannelMaker) {
    logger.error('Insufficient funds in inbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_INBOUND(order.orderId))
  }

  if (!sufficientBalanceInOutboundChannelTaker) {
    logger.error('Insufficient funds in outbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_OUTBOUND(order.orderId))
  }

  if (!sufficientBalanceInInboundChannelTaker) {
    logger.error('Insufficient funds in inbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_INBOUND(order.orderId))
  }
}

module.exports = fillOrder
