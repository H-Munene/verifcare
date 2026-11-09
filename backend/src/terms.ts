// The terms of use and privacy notice each mobile app asks its users to accept (2026-09-26, the
// consent screen). Served by the API rather than built into the apps, so the wording can change
// without an app release; bumping a document's `version` asks every user of that app to accept
// again (terms_acceptances keeps one row per version accepted).
//
// Version 1 is a first draft written for the user's legal review (user decision: "draft it,
// marked v1"), grounded in the Kenya Data Protection Act, 2019 and in what this system actually
// does - each factual statement below matches the implementation (hosting region, retention,
// who sees what). Before production, the data protection contact below must be replaced with a
// real address, and the text reviewed by a qualified advisor.
//
// Version 2 (2026-09-27) adds the consent screen's two required checkboxes - photo identity
// verification and audio recording during visits - and a section explaining them. The bump is what
// makes every existing user see the screen again and give those consents, since v1 acceptances
// never asked for them.
//
// Version 3 (2026-11-09) reflects the end of face matching and cognitive monitoring. Check-in now
// uses location and a code on a family member's phone, and visit audio is for the family to listen
// to. The two checkboxes become location and visit audio. The bump matters: earlier acceptances
// consented to purposes that no longer exist, so everyone is asked again.

export type TermsDocumentType = 'caregiver' | 'family_member';

export interface TermsSection {
  heading: string;
  paragraphs: string[];
}

export interface TermsDocument {
  document: TermsDocumentType;
  version: string;
  title: string;
  effectiveDate: string;
  sections: TermsSection[];
}

const rights: TermsSection = {
  heading: 'Your rights',
  paragraphs: [
    'Under the Kenya Data Protection Act, 2019 you can ask to see the personal data we hold about you, have it corrected or deleted, object to how it is used, and withdraw your consent at any time. Withdrawing consent does not affect anything done before you withdrew it, but you will not be able to keep using the app.',
    'If you are not satisfied with how we handle your data, you can complain to the Office of the Data Protection Commissioner (ODPC).',
  ],
};

const hosting: TermsSection = {
  heading: 'Where your data is kept',
  paragraphs: [
    'Your data is stored on Amazon Web Services in the European Union (Ireland), encrypted in storage and in transit. Maps are provided by Google Maps. These providers process data only to provide these services to Mzazi Care.',
  ],
};

const contact: TermsSection = {
  heading: 'Contact',
  paragraphs: [
    'For any question about your data or these terms, or to use your rights, contact your Mzazi Care supervisor, who will pass your request to our data protection contact.',
  ],
};

const caregiverTerms: TermsDocument = {
  document: 'caregiver',
  version: '3',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-11-09',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        'Mzazi Care connects caregivers with the families of older people who need care at home. As a caregiver you use this app to see your visits, check in and out, record the care you give, and make a short audio recording at each visit.',
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number.',
        "Your location when you check in and check out, to confirm you are at the dependant's home. We do not track your location between visits.",
        "What happens on each visit: check-in and check-out times, how you checked in, the care tasks you record, and your notes. To check in you scan a code on a family member's phone, or ask a supervisor if nobody from the family is there.",
        "A recording of up to 30 seconds that you make during each visit, where the dependant's family has agreed. The dependant's family can listen to it, as added assurance that the visit took place. It is not analysed by any automated system.",
      ],
    },
    {
      heading: 'Why we collect it',
      paragraphs: [
        'To confirm that visits happen as scheduled and by the right person, to keep dependants safe, to let supervisors and families follow the care given, and to alert a supervisor when a visit is missed.',
      ],
    },
    {
      heading: 'Who can see it',
      paragraphs: [
        "Mzazi Care supervisors can see your details and visit records, and whether each visit has a recording, but they cannot listen to it. A dependant's family members can see your name, your visit times and the care recorded on their dependant's visits, and can listen to that visit's recording. They cannot see your phone number or your email address.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Visit recordings are deleted after 90 days. Visit records are kept as part of the care history.',
      ],
    },
    {
      heading: 'Your consent to location checks and audio',
      paragraphs: [
        "Below these terms we ask for two separate consents, each with its own checkbox: to your location being checked against the dependant's home when you check in and out, and to audio being recorded during your visits. You need to give both to use the app.",
        'Visits can only be scheduled for a caregiver who has consented to location checks. To withdraw either consent later, ask your supervisor.',
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By ticking both boxes and tapping Accept you confirm that you have read this notice and agree to these terms, including the use of your location and visit audio described above. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

const familyMemberTerms: TermsDocument = {
  document: 'family_member',
  version: '3',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-11-09',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        'Mzazi Care connects the families of older people who need care at home with trained caregivers. As a family member you use this app to register a dependant, follow their visits and the care given, show a check-in code when a caregiver arrives, and stay in touch with the rest of their family on Mzazi Care.',
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number, and your identity document where one was recorded when you were registered.',
        'Details you give us about a dependant: their name, date of birth, gender, home address and the exact location of their home, and their main health condition.',
        "Your phone's location at the moment you show a check-in code, to confirm you are at the dependant's home. We keep only how far you were from the home, and we do not track your location at any other time.",
        "Visit records for your dependants: check-in and check-out times, how the caregiver checked in, the care tasks recorded, and caregivers' notes.",
        'A recording of up to 30 seconds made by the caregiver during each visit, for you and the other family members linked to the dependant to listen to. It is not analysed by any automated system.',
      ],
    },
    {
      heading: "Your dependant's consent",
      paragraphs: [
        'By registering or managing a dependant you confirm that you are authorised to share their details with Mzazi Care and, where they cannot give consent themselves, to consent on their behalf to location checks at their home and to audio being recorded during their visits.',
      ],
    },
    {
      heading: 'Why we collect it',
      paragraphs: [
        'To arrange and verify care visits, to make sure caregivers visit the right person at the right home, to let you and your family follow the care given, and to alert a supervisor when a visit is missed.',
      ],
    },
    {
      heading: 'Who can see it',
      paragraphs: [
        "Mzazi Care supervisors can see everything described above, except that they can only see whether a visit has a recording and cannot listen to it. A caregiver assigned to a dependant can see what they need for the visit: the dependant's name, home location and care plan. The other family members linked to the same dependant can see your name, relationship, phone number and email address, so you can coordinate care. They cannot see your identity document.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Visit recordings are deleted after 90 days. Visit records are kept as part of the care history.',
      ],
    },
    {
      heading: 'Your consent for location checks and audio',
      paragraphs: [
        'Below these terms we ask for two separate consents, each with its own checkbox, given for yourself and on behalf of every dependant you register or are the primary contact for: to location being checked at check-in and check-out at their home, and to audio being recorded during their visits for the family to listen to. You need to give both to use the app.',
        'Visits can only be scheduled for a dependant whose location consent is in place. To withdraw either consent for a dependant later, contact your Mzazi Care supervisor.',
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By ticking both boxes and tapping Accept you confirm that you have read this notice, agree to these terms, and give both consents above. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

/** The current document for an app's users - the one they must have accepted to use it. */
export const CURRENT_TERMS: Record<TermsDocumentType, TermsDocument> = {
  caregiver: caregiverTerms,
  family_member: familyMemberTerms,
};
