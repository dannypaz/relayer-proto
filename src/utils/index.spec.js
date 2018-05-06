const { expect, mock } = require('test/test-helper.spec')

describe('utils index', () => {
  let utils

  beforeEach(() => {
    mock('./logger', {})
    mock('./db', {})
    mock('./promise-once', {})
    mock('./load-proto', {})
    mock('./load-implementation', {})

    utils = require('./index')
  })

  afterEach(() => {
    mock.stopAll()
  })

  describe('implementations', () => {
    it('logger', () => expect(utils.logger).to.be.implemented())
    it('db', () => expect(utils.db).to.be.implemented())
    it('promiseOnce', () => expect(utils.promiseOnce).to.be.implemented())
    it('loadProto', () => expect(utils.loadProto).to.be.implemented())
    it('addGrpcImplementation', () => expect(utils.addGrpcImplementation).to.be.implemented())
  })
})