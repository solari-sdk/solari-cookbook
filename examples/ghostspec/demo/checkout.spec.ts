import { test, expect } from '@playwright/test';

test('log in as standard_user with password secret_sauce, add the Sauce Labs Backpack to the cart, open the cart and complete checkout with name Nikhil Jatt and zip 110001', async ({ page }) => {
  // Start at the SauceDemo login page
  await page.goto('https://www.saucedemo.com');

  // Enter the username to begin login
  await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');

  // Enter the password to complete login credentials
  await page.getByRole('textbox', { name: 'Password' }).fill('secret_sauce');

  // Submit the login form
  await page.getByRole('button', { name: 'Login' }).click();

  // Confirm login succeeded and the inventory page loaded
  await expect(page.getByText('Products')).toBeVisible();

  // Add the Sauce Labs Backpack (first product) to the cart
  await page.getByRole('button', { name: 'Add to cart' }).first().click();

  // Confirm the cart badge shows 1 item after adding the product
  await expect(page.getByText('1').first()).toBeVisible();

  // Open the cart by clicking the cart icon/badge
  await page.getByText('1').first().click();

  // Proceed from the cart to the checkout information page
  await page.getByRole('button', { name: 'Checkout' }).click();

  // Fill in first name for checkout information
  await page.getByRole('textbox', { name: 'First Name' }).fill('Nikhil');

  // Fill in last name for checkout information
  await page.getByRole('textbox', { name: 'Last Name' }).fill('Jatt');

  // Fill in zip code to complete checkout information
  await page.getByRole('textbox', { name: 'Zip/Postal Code' }).fill('110001');

  // Submit checkout information form
  await page.getByRole('button', { name: 'Continue' }).click();

  // Submit the order to complete checkout
  await page.getByRole('button', { name: 'Finish' }).click();

  // Confirm checkout completed and order confirmation is displayed
  await expect(page.getByText('Thank you for your order!')).toBeVisible();
});
