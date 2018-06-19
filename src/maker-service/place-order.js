const { PublicError } = require('../errors')

const { Order, FeeInvoice, DepositInvoice, FeeRefundInvoice, DepositRefundInvoice } = require('../models')

const FRIENDLY_ERRORS = {
  NOT_PLACED: id => `Could not place order. Please create another order and try again. Order id: ${id}`,
  FEE_NOT_PAID: id => `Fee Invoice has not been paid. Order id: ${id}`,
  DEPOSIT_NOT_PAID: id => `Deposit Invoice has not been paid. Order id: ${id}`,
  FEE_VALUES_UNEQUAL: id => `Fee Invoice Refund value is not the same as Fee Invoice value. Order id: ${id}`,
  DEPOSIT_VALUES_UNEQUAL: id => `Deposit Invoice Refund value is not the same as Deposit Invoice value. Order id: ${id}`,
  INSUFFICIENT_FUNDS_OUTBOUND: id => `Outbound channel does not have sufficient balance. Order id: ${id}`,
  INSUFFICIENT_FUNDS_INBOUND: id => `Inbound channel does not have sufficient balance. Order id: ${id}`
}

/**
 * Given an orderId and refundInvoice, place an order in the relayer. This will
 * make the order actionable to all other users.
 *
 * 1. Given the orderId, we need to check a few things
 *   - make sure that the fees and deposits have been paid
 *   - make sure it even exists
 *   - make sure that it is a valid order (not cancelled or whatever) preferably
 *     by querying mongo for created orders?
 *   - checks if the maker is reachable on Lightning Network on channels
 *   - sufficient to complete swap (depending on fill amount)
 * 2. Create a new order with the refundinvoice in the created status
 * 3. Broadcast to everyone
 *
 * @param {GrpcUnaryMethod~request} request - request object
 * @param {Object} request.params - Request parameters from the client
 * @param {Object} request.logger - logger for messages about the method
 * @param {EventEmitter} request.eventHandler - Event bus to put order messages onto
 * @param {Object} responses
 * @param {function} responses.PlaceOrderResponse - constructor for PlaceOrderResponse messages
 * @return {responses.PlaceOrderResponse}
 */
/* eslint-disable standard/no-callback-literal */
async function placeOrder ({ params, logger, eventHandler, engine }, { EmptyResponse }) {
  const { orderId, feeRefundPaymentRequest, depositRefundPaymentRequest } = params

  // TODO: validate ownership of the order
  const order = await Order.findOne({ orderId })
  const feeInvoice = await FeeInvoice.findOne({ foreignId: order._id })
  const depositInvoice = await DepositInvoice.findOne({ foreignId: order._id })

  // This circumstance means that either 1. the relayer messed up or 2. the CLI is broken.
  // In either scenario, there is nothing actionable that the user can do. We need to
  // cancel the order and prompt the user to retry the order again.
  if (!feeInvoice || !depositInvoice) {
    logger.error('Fee invoice could not be found for order', { orderId, feeInvoice, depositInvoice })
    throw new PublicError(FRIENDLY_ERRORS.NOT_PLACED(order.orderId))
  }

  const [feeInvoicePaid, depositInvoicePaid] = await Promise.all([
    engine.isInvoicePaid(feeInvoice.paymentRequest),
    engine.isInvoicePaid(depositInvoice.paymentRequest)
  ])

  if (!feeInvoicePaid) {
    logger.error('Fee not paid for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.FEE_NOT_PAID(order.orderId))
  }

  if (!depositInvoicePaid) {
    logger.error('Deposit not paid for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.DEPOSIT_NOT_PAID(order.orderId))
  }

  const [sufficientBalanceInOutboundChannel, sufficientBalanceInInboundChannel] = await Promise.all([
    engine.isBalanceSufficient(order.payTo.slice(3), order.counterAmount, {outbound: true}),
    engine.isBalanceSufficient(order.payTo.slice(3), order.baseAmount, {outbound: false})
  ])

  if (!sufficientBalanceInOutboundChannel) {
    logger.error('Insufficient funds in outbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_OUTBOUND(order.orderId))
  }

  if (!sufficientBalanceInInboundChannel) {
    logger.error('Insufficient funds in inbound channel for order', { orderId: order.orderId })
    throw new PublicError(FRIENDLY_ERRORS.INSUFFICIENT_FUNDS_INBOUND(order.orderId))
  }

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

  // TODO: Handle DB failure in case of one record failing to be created
  await Promise.all([
    FeeRefundInvoice.create({ foreignId: order._id, paymentRequest: feeRefundPaymentRequest }),
    DepositRefundInvoice.create({ foreignId: order._id, paymentRequest: depositRefundPaymentRequest })
  ])

  logger.info('Refund invoices have been stored on the Relayer')

  if (order.status === Order.STATUSES.CANCELLED) {
    logger.info('Order is in cancelled state, refunding', { orderId: order.orderId })

    const [feeRefundInvoice, depositRefundInvoice] = await Promise.all([
      FeeRefundInvoice.findOne({ foreignId: order._id }),
      DepositRefundInvoice.findOne({ foreignId: order._id })
    ])

    if (!feeRefundInvoice.preimage) {
      const feePreimage = await engine.payInvoice(feeRefundInvoice.paymentRequest)
      feeRefundInvoice.preimage = feePreimage
      feeRefundInvoice.save()
    }

    if (!depositRefundInvoice.preimage) {
      const depositPreimage = await engine.payInvoice(depositRefundInvoice.paymentRequest)
      depositRefundInvoice.preimage = depositPreimage
      depositRefundInvoice.save()
    }

    logger.info('Refunding complete', { orderId: order.orderId })
    return {}
  }

  await order.place()

  eventHandler.emit('order:placed', order)
  logger.info('order:placed', { orderId: order.orderId })

  return new EmptyResponse({})
}

module.exports = placeOrder
