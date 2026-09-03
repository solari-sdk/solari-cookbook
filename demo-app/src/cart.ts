export function calculateTotal(
    price: number,
    quantity: number
  ): number {
    // BUG: quantity is accidentally ignored.
    return price;
  }