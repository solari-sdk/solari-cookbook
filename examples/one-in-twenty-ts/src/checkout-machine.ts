/**
 * Checkout shipping/pay state machine.
 *
 * Pay used to do one 80ms check of `pending` and freeze in `paying` forever
 * if shipping was still in flight. The fix: if payment is waiting, complete
 * it when the current shipping operation finishes.
 */
export type CheckoutStatus = "ready" | "shipping" | "paying" | "paid" | "error"

export type CheckoutSnap = {
  state: CheckoutStatus
  pending: number
  shipping: string
  shippingCost: number
  paidCount: number
  statusText: string
}

export function createCheckout(opts?: { resumePayOnShipping?: boolean }) {
  const resumePayOnShipping = opts?.resumePayOnShipping !== false
  const PRODUCT = 20
  let state: CheckoutStatus = "ready"
  let pending = 0
  let shipping = "standard"
  let shippingCost = 5
  let paidCount = 0
  let statusText = "Ready"
  let shippingSeq = 0
  let payGen = 0

  function snap(): CheckoutSnap {
    return { state, pending, shipping, shippingCost, paidCount, statusText }
  }

  function completePay(method: string, cost: number, gen: number) {
    if (state === "paid") return false
    if (gen !== payGen) return false
    state = "paid"
    paidCount += 1
    shipping = method
    shippingCost = cost
    statusText = "Paid " + method + " $" + (PRODUCT + cost)
    return true
  }

  return {
    snap,
    startShipping() {
      pending += 1
      shippingSeq += 1
      state = "shipping"
      statusText = "Updating shipping…"
      return shippingSeq
    },
    finishShipping(seq: number, method: string, cost: number) {
      pending -= 1
      if (seq !== shippingSeq) {
        if (resumePayOnShipping && state === "paying" && pending === 0) {
          const ok = completePay(shipping, shippingCost, payGen)
          return { applied: false, completedPay: ok }
        }
        return { applied: false, completedPay: false }
      }
      if (state === "paid") {
        state = "error"
        statusText = "Shipping update overwrote paid checkout"
        return { applied: false, completedPay: false }
      }
      shipping = method
      shippingCost = cost
      if (resumePayOnShipping && state === "paying" && pending === 0) {
        const ok = completePay(method, cost, payGen)
        return { applied: true, completedPay: ok }
      }
      if (pending === 0 && state !== "paying") {
        state = "ready"
        statusText = "Shipping ready"
      }
      return { applied: true, completedPay: false }
    },
    pay() {
      if (state === "paid") return { started: false, gen: payGen }
      payGen += 1
      const gen = payGen
      const capturedShipping = shipping
      const capturedCost = shippingCost
      state = "paying"
      statusText = "Processing payment…"
      return {
        started: true,
        gen,
        afterPayDelay() {
          if (state === "paid") return { completed: false, waiting: false }
          if (pending > 0) {
            if (!resumePayOnShipping) {
              state = "paying"
              statusText = "Processing payment…"
            }
            return { completed: false, waiting: true }
          }
          const ok = completePay(capturedShipping, capturedCost, gen)
          return { completed: ok, waiting: false }
        },
      }
    },
  }
}
