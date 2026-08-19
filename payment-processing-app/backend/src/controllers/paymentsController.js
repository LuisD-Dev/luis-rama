import { Payment } from '../models/purchaseModel.js';
import paymentGateway from '../services/paymentGateway.js';

export const createPaymentIntent = async (req, res) => {
    const { amount, currency, userId } = req.body;

    try {
        // Create a payment intent using the simulated payment gateway
        const paymentIntent = await paymentGateway.createPaymentIntent(amount, currency);

        // Save the payment record in the database
        const paymentRecord = await Payment.create({
            status: 'pending',
            amount,
            currency,
            userId,
            paymentIntentId: paymentIntent.id,
        });

        res.status(200).json({
            success: true,
            paymentIntent: paymentIntent,
            paymentRecord: paymentRecord,
        });
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create payment intent',
        });
    }
};

export const confirmPayment = async (req, res) => {
    const { paymentIntentId } = req.body;

    try {
        // Confirm the payment using the simulated payment gateway
        const confirmedPayment = await paymentGateway.confirmPayment(paymentIntentId);

        // Update the payment record in the database
        const paymentRecord = await Payment.findOneAndUpdate(
            { paymentIntentId },
            { status: confirmedPayment.status },
            { new: true }
        );

        res.status(200).json({
            success: true,
            paymentRecord: paymentRecord,
        });
    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to confirm payment',
        });
    }
};