import { test } from "node:test"
import assert from "node:assert/strict"
import { createCheckout } from "./checkout-machine.ts"

test("old one-shot pay check stays stuck if shipping is still pending", () => {
  const c = createCheckout({ resumePayOnShipping: false })
  c.startShipping()
  const pay = c.pay()
  assert.equal(c.snap().state, "paying")
  const delay = pay.afterPayDelay()
  assert.equal(delay.waiting, true)
  assert.equal(c.snap().state, "paying")
  c.finishShipping(1, "express", 15)
  assert.equal(c.snap().state, "paying")
  assert.equal(c.snap().paidCount, 0)
})

test("fix: late shipping completes a waiting payment", () => {
  const c = createCheckout()
  c.startShipping()
  const pay = c.pay()
  pay.afterPayDelay()
  assert.equal(c.snap().state, "paying")
  const fin = c.finishShipping(1, "express", 15)
  assert.equal(fin.completedPay, true)
  assert.equal(c.snap().state, "paid")
  assert.equal(c.snap().paidCount, 1)
  assert.equal(c.snap().statusText, "Paid express $35")
})

test("fix: shipping that finishes before pay delay still pays once", () => {
  const c = createCheckout()
  c.startShipping()
  c.finishShipping(1, "express", 15)
  const pay = c.pay()
  pay.afterPayDelay()
  assert.equal(c.snap().state, "paid")
  assert.equal(c.snap().paidCount, 1)
})

test("fix: no duplicate payment completion", () => {
  const c = createCheckout()
  c.startShipping()
  const pay = c.pay()
  c.finishShipping(1, "express", 15)
  assert.equal(c.snap().paidCount, 1)
  pay.afterPayDelay()
  pay.afterPayDelay()
  assert.equal(c.snap().paidCount, 1)
  assert.equal(c.snap().state, "paid")
})

test("stale shipping response does not apply over a newer request", () => {
  const c = createCheckout()
  const seq1 = c.startShipping()
  const seq2 = c.startShipping()
  const pay = c.pay()
  pay.afterPayDelay()
  const first = c.finishShipping(seq1, "standard", 5)
  assert.equal(first.applied, false)
  assert.equal(c.snap().state, "paying")
  assert.equal(c.snap().paidCount, 0)
  const second = c.finishShipping(seq2, "express", 15)
  assert.equal(second.applied, true)
  assert.equal(second.completedPay, true)
  assert.equal(c.snap().shipping, "express")
  assert.equal(c.snap().paidCount, 1)
})

test("no duplicate shipping starts from a single change", () => {
  const c = createCheckout()
  const seq = c.startShipping()
  assert.equal(seq, 1)
  assert.equal(c.snap().pending, 1)
})
