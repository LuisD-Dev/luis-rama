const express = require('express');

class PaymentGateway {
    constructor() {
        this.payments = [];
    }

    createPaymentIntent(amount, currency) {
        const paymentIntent = {
            id: this.generateId(),
            amount,
            currency,
            status: 'pending',
        };
        this.payments.push(paymentIntent);
        return paymentIntent;
    }

    confirmPayment(paymentId) {
        const payment = this.payments.find(p => p.id === paymentId);
        if (payment) {
            payment.status = 'confirmed';
            return payment;
        }
        throw new Error('Payment not found');
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}

module.exports = new PaymentGateway();