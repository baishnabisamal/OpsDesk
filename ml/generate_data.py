"""Writes data/tickets.csv: labelled example tickets for training.

There are no real support tickets to learn from, so this script builds
examples by combining hand-written phrases. That makes the data SYNTHETIC:
the score the model gets on it says "the pipeline works", not "the model is
good on real customers". Real labels arrive later from agents' overrides
(the intent_overrides table).

The same seed gives the same file every time.

Run:  python generate_data.py
"""

import csv
import random
from pathlib import Path

SEED = 42
ROWS_PER_INTENT = 220
OUTPUT = Path(__file__).parent / "data" / "tickets.csv"

# For each intent: ways to say the subject, and ways to say the body.
PHRASES = {
    "booking_not_found": {
        "subjects": [
            "Booking not found at hotel",
            "Hotel has no reservation for our guest",
            "Guest turned away at reception",
            "Reservation missing on arrival",
            "Front desk cannot locate the booking",
            "No record of our reservation",
            "Hotel denies having the booking",
            "Client stranded, hotel shows nothing",
        ],
        "bodies": [
            "The guest is standing at reception and the hotel cannot find the booking.",
            "Hotel staff say there is no reservation under the guest name.",
            "Our client arrived tonight and was told the room does not exist in their system.",
            "The property has no record of this confirmation number.",
            "Reception checked twice and nothing shows up for these dates.",
            "The hotel says the supplier never sent them this reservation.",
            "Guest has been waiting in the lobby for an hour with no room.",
            "Please reconfirm with the hotel urgently, they see nothing on their side.",
        ],
    },
    "cancellation": {
        "subjects": [
            "Please cancel this booking",
            "Cancellation request",
            "Client no longer travelling",
            "Need to cancel the reservation",
            "Cancel before the deadline please",
            "Trip called off, cancel room",
            "Request to cancel free of charge",
            "Guest cancelled their trip",
        ],
        "bodies": [
            "The client no longer needs the room, please cancel it.",
            "Kindly cancel this reservation before the free cancellation deadline.",
            "The trip has been called off, we want to cancel without a penalty.",
            "Please confirm the cancellation in writing once it is done.",
            "The guest fell ill and cannot travel, please cancel.",
            "We want to cancel all nights of this stay.",
            "Is it still possible to cancel free of charge today?",
            "Cancel the booking and send us the cancellation number.",
        ],
    },
    "amendment": {
        "subjects": [
            "Change of guest name",
            "Need to change the stay dates",
            "Please amend the booking",
            "Add one more night",
            "Wrong spelling of the guest name",
            "Change room type",
            "Modify number of guests",
            "Date change request",
        ],
        "bodies": [
            "The lead guest name is spelled wrong, please correct it.",
            "The guest wants to arrive one day later, can the dates be moved?",
            "Please change the room from twin to double.",
            "We need to add a child to this reservation.",
            "Kindly extend the stay by one extra night.",
            "The traveller has changed, please update the name on the booking.",
            "Can you shorten the stay by two nights?",
            "Please update the arrival date and confirm the new rate.",
        ],
    },
    "refund": {
        "subjects": [
            "Refund not received",
            "Where is our refund",
            "Refund amount is lower than expected",
            "Still waiting for money back",
            "Refund pending for two weeks",
            "Partial refund received only",
            "Reimbursement not processed",
            "Refund status please",
        ],
        "bodies": [
            "The booking was cancelled ten days ago and the refund has not arrived.",
            "We were refunded less than the amount we paid, please check.",
            "Our client keeps asking when the money will be returned.",
            "The refund was promised within seven days and nothing has come.",
            "Please share the refund reference so we can trace it with the bank.",
            "Only half of the amount has been reimbursed so far.",
            "The credit has not reached our account yet.",
            "When will the money be returned to our wallet?",
        ],
    },
    "voucher": {
        "subjects": [
            "Voucher shows wrong dates",
            "Voucher not received",
            "Please resend the hotel voucher",
            "Voucher has the wrong guest name",
            "Cannot download the voucher",
            "Voucher missing meal plan",
            "Hotel does not accept the voucher",
            "Voucher shows wrong room type",
        ],
        "bodies": [
            "The voucher shows different dates from our confirmation.",
            "We never received the voucher by email, please send it again.",
            "The voucher link gives an error when we try to open it.",
            "Breakfast is not mentioned on the voucher although it was booked.",
            "The confirmation document lists the wrong hotel address.",
            "The guest needs the voucher today for the visa appointment.",
            "The document shows one adult but the booking is for two.",
            "Please issue a corrected voucher with the right room type.",
        ],
    },
    "payment": {
        "subjects": [
            "Charged twice for one booking",
            "Payment failed but amount deducted",
            "Double charge on card",
            "Invoice does not match the price",
            "Card declined at checkout",
            "Wrong amount charged",
            "Payment stuck in processing",
            "Need the invoice for this booking",
        ],
        "bodies": [
            "Our card statement shows two charges for this booking.",
            "The payment failed on screen but the amount left our account.",
            "We were charged more than the price shown at booking time.",
            "The card was declined three times, please check the gateway.",
            "The invoice total is different from what was debited.",
            "The transaction is still showing as processing after two days.",
            "Please send a tax invoice with our company details.",
            "The amount was deducted in the wrong currency.",
        ],
    },
    "other": {
        "subjects": [
            "Late check-out request",
            "Early check-in possible?",
            "Is breakfast included",
            "Airport transfer question",
            "Extra bed request",
            "Honeymoon decoration request",
            "Parking at the hotel",
            "General question about the hotel",
        ],
        "bodies": [
            "Can the guest have a late check-out until four in the afternoon?",
            "The flight lands early, can they get the room in the morning?",
            "Please tell us whether breakfast is part of this rate.",
            "Does the hotel offer a pick up from the airport?",
            "The family needs an extra bed for a child.",
            "The couple is on honeymoon, can the hotel arrange something special?",
            "Is there parking and what does it cost per night?",
            "Does the hotel have a pool and is it open in winter?",
        ],
    },
}

GREETINGS = ["", "", "Hello team,", "Hi,", "Dear support,", "Good morning,", "Urgent:"]
CLOSINGS = ["", "", "Thanks.", "Please help.", "Waiting for your reply.", "Regards.", "This is urgent."]

# Sentences that say nothing about the intent. Real tickets are full of them.
FILLER = [
    "The guest is a regular client of ours.",
    "We already called the hotline and nobody answered.",
    "Check-in is this week.",
    "Please treat this as a priority.",
    "The booking was made last month.",
    "Our customer is very upset.",
]


def make_ticket(rng: random.Random, intent: str) -> tuple[str, str]:
    """Builds one subject and one body for the given intent."""
    phrases = PHRASES[intent]
    subject = rng.choice(phrases["subjects"])
    parts = [rng.choice(GREETINGS), rng.choice(phrases["bodies"])]

    # Half the tickets get a second sentence from the same intent.
    if rng.random() < 0.5:
        parts.append(rng.choice(phrases["bodies"]))
    if rng.random() < 0.6:
        parts.append(rng.choice(FILLER))

    # Some tickets mention another problem too, as real ones do. This is what
    # stops the task from being trivially easy.
    if rng.random() < 0.15:
        other_intent = rng.choice([name for name in PHRASES if name != intent])
        parts.append(rng.choice(PHRASES[other_intent]["bodies"]))

    # Some tickets have a subject that says nothing useful.
    if rng.random() < 0.15:
        subject = rng.choice(["Urgent help needed", "Problem with booking", "Please assist", "Query"])

    parts.append(rng.choice(CLOSINGS))
    body = " ".join(part for part in parts if part)
    return subject, body


def main() -> None:
    rng = random.Random(SEED)
    rows = []
    for intent in PHRASES:
        for _ in range(ROWS_PER_INTENT):
            subject, body = make_ticket(rng, intent)
            rows.append({"subject": subject, "body": body, "intent": intent})
    rng.shuffle(rows)

    OUTPUT.parent.mkdir(exist_ok=True)
    with OUTPUT.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=["subject", "body", "intent"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"wrote {len(rows)} rows to {OUTPUT}")


if __name__ == "__main__":
    main()
