const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/paymentsController');

// Route to create a payment intent
router.post('/intent', paymentsController.createPaymentIntent);

// Route to confirm a payment
router.post('/confirm', paymentsController.confirmPayment);

module.exports = router;