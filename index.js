require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const IntaSend = require('intasend-node');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('URL:', supabaseUrl);
console.log('KEY:', supabaseKey ? 'found' : 'MISSING');

const supabase = createClient(supabaseUrl, supabaseKey);

const client = new IntaSend(
  process.env.INSTASEND_API_TOKEN,
  process.env.INSTASEND_PUBLISHABLE_KEY,
  'TEST' // change to 'PRODUCTION' when you go live
);

// ─── TRIPS ───────────────────────────────────────────

app.get('/trips', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .order('start_date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/trips', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .insert([req.body])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/trips/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('trips')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/trips/:id', async (req, res) => {
  const { error } = await supabase
    .from('trips')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BOOKINGS ────────────────────────────────────────

app.get('/bookings', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/bookings', async (req, res) => {
  const { trip_id, name, email, phone, count, notes, payment_method } = req.body;

  // 1. Get the trip
  const { data: trip, error: tripErr } = await supabase
    .from('trips')
    .select('*')
    .eq('id', trip_id)
    .single();

  if (tripErr || !trip) return res.status(404).json({ error: 'Trip not found' });

  const avail = trip.spots - (trip.booked || 0);
  if (count > avail) return res.status(400).json({ error: `Only ${avail} spot(s) left` });

  // 2. Save booking as pending
  const { data: booking, error: bookErr } = await supabase
    .from('bookings')
    .insert([{
      trip_id,
      trip_name: trip.name,
      name, email, phone, notes,
      count,
      total: trip.price * count,
      status: 'pending'
    }])
    .select()
    .single();

  if (bookErr) return res.status(500).json({ error: bookErr.message });

  // 3. Initiate payment
  try {
    let paymentResponse;

    if (payment_method === 'mpesa') {
      // M-Pesa STK push
      paymentResponse = await client.PaymentLinks.create({
        currency:     'KES',
        amount:       trip.price * count,
        title:        trip.name,
        first_name:   name.split(' ')[0],
        last_name:    name.split(' ')[1] || '',
        email:        email,
        phone_number: phone,
        comment:      `Booking ref: ${booking.id}`
      });
    } else {
      // Card payment link
      paymentResponse = await client.PaymentLinks.create({
        currency:   'KES',
        amount:     trip.price * count,
        title:      trip.name,
        first_name: name.split(' ')[0],
        last_name:  name.split(' ')[1] || '',
        email:      email,
        comment:    `Booking ref: ${booking.id}`
      });
    }

    // 4. Save payment reference against booking
    const invoiceId = paymentResponse?.id || paymentResponse?.invoice?.invoice_id;

    await supabase
      .from('bookings')
      .update({ payment_ref: invoiceId })
      .eq('id', booking.id);

    res.json({
      booking_id:  booking.id,
      payment_url: paymentResponse?.url || paymentResponse?.checkout_url || null,
      invoice_id:  invoiceId
    });

  } catch (err) {
    console.error('Instasend error:', err);
    res.status(500).json({ error: 'Payment initiation failed', detail: err.message });
  }
});

// ─── INSTASEND WEBHOOK ───────────────────────────────
// Add this URL in Instasend dashboard → Settings → Webhooks:
// https://your-railway-url/webhook/instasend

app.post('/webhook/instasend', async (req, res) => {
  console.log('Webhook received:', req.body);

  const { invoice_id, state } = req.body;

  if (state !== 'COMPLETE') return res.sendStatus(200);

  // Find booking by payment ref
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('payment_ref', invoice_id)
    .single();

  if (error || !booking) {
    console.log('Booking not found for invoice:', invoice_id);
    return res.sendStatus(200);
  }

  // Mark confirmed
  await supabase
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', booking.id);

  // Decrement spots
  await supabase.rpc('decrement_spots', {
    trip_id: booking.trip_id,
    amount:  booking.count
  });

  console.log(`Booking ${booking.id} confirmed, ${booking.count} spot(s) decremented`);
  res.sendStatus(200);
});

// ─── START ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wander API running on port ${PORT}`));