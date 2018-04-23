const mock = require('mock-require')
const chai = require('chai')
const sinon = require('sinon')

const { expect } = chai

chai.use(require('sinon-chai'))

class GrpcServer {
  listen () {}
}

describe('Relayer', () => {
  let sandbox
  let Relayer

  before(() => { sandbox = sinon.sandbox.create() })
  afterEach(() => { sandbox.restore() })

  const fakeDb = sinon.spy()
  const fakeLogger = sinon.spy()
  const fakeEngine = sinon.spy()
  const fakeServer = sinon.spy(() => sinon.createStubInstance(GrpcServer))

  beforeEach(() => {
    // Setup utils
    mock('./utils', {
      db: fakeDb,
      logger: { error: fakeLogger }
    })
    mock('./events', {})
    mock('./grpc-server', fakeServer)
    mock('./payment-engines', { LndEngine: fakeEngine })

    Relayer = require('./index')
  })

  describe('intialization', () => {
    it('returns an intance of a db', () => {
      expect(Relayer.db).to.eq(fakeDb)
    })
  })
})
