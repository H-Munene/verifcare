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
//
// Version 4 (2026-11-13) adds voice verification: two recordings at each visit, each checked
// against an enrolled voiceprint, with a third required checkbox. Version 3 promised recordings
// were "not analysed by any automated system", so everyone must agree again before any is.

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

const voiceChecks = (whose: string): TermsSection => ({
  heading: 'Voice checks',
  paragraphs: [
    `Each visit recording is compared automatically with the voiceprint of the person it should be, to help confirm that ${whose} were at the visit. A voiceprint is a set of numbers describing how a voice sounds, made once from about 30 seconds of speech. It is biometric data, and is kept encrypted where only the voice check can read it.`,
    'The result for each recording (a match, a mismatch, or too little speech to judge) and its similarity score are shown to Mzazi Care supervisors. The check can be wrong, for example with background noise or a cold, so it is advisory only: it never stops a visit from counting and is never used on its own to decide anything about anyone.',
  ],
});

const caregiverTerms: TermsDocument = {
  document: 'caregiver',
  version: '4',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-11-13',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        "Mzazi Care connects caregivers with the families of older people who need care at home. As a caregiver you use this app to see your visits, check in and out, record the care you give, and record your own voice and the dependant's voice at each visit.",
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number.',
        "Your location when you check in and check out, to confirm you are at the dependant's home. We do not track your location between visits.",
        "What happens on each visit: check-in and check-out times, how you checked in and out, the care tasks you record, and your notes. To check in you scan a code on a family member's phone, or ask a supervisor if nobody from the family is there. To check out you scan or type a code from a family member's phone, or give a reason if you can't.",
        "Two recordings of 10 to 30 seconds at each visit: your voice, then the dependant's. The dependant's family can listen to the dependant's recording, as added assurance that the visit took place.",
        'A voiceprint of your voice, made from about 30 seconds of speech that you record once in the app.',
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
        "Mzazi Care supervisors can see your details, your visit records and each visit's voice check results, but they cannot listen to the recordings. A dependant's family members can see your name, your visit times and the care recorded on their dependant's visits, and can listen to the dependant's recording, not yours. They cannot see your phone number or your email address.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Visit recordings are deleted after 90 days. Voice check results are kept with the visit records, as part of the care history. Your voiceprint is kept while you work with Mzazi Care, replaced if you record it again, and deleted when your account is closed.',
      ],
    },
    voiceChecks('you and the dependant'),
    {
      heading: 'Your consent to location checks, audio and voice checks',
      paragraphs: [
        "Below these terms we ask for three separate consents, each with its own checkbox: to your location being checked against the dependant's home when you check in and out, to audio being recorded during your visits, and to your voice being checked against your voiceprint. You need to give all three to use the app.",
        'Visits can only be scheduled for a caregiver who has consented to location checks. To withdraw any consent later, ask your supervisor.',
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By ticking all three boxes and tapping Accept you confirm that you have read this notice and agree to these terms, including the use of your location, visit audio and voice described above. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

const familyMemberTerms: TermsDocument = {
  document: 'family_member',
  version: '4',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-11-13',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        "Mzazi Care connects the families of older people who need care at home with trained caregivers. As a family member you use this app to register a dependant, follow their visits and the care given, record your dependant's voice once, show a code when a caregiver arrives and leaves, and stay in touch with the rest of their family on Mzazi Care.",
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number, and your identity document where one was recorded when you were registered.',
        'Details you give us about a dependant: their name, date of birth, gender, home address and the exact location of their home, and their main health condition.',
        "Your phone's location at the moment you show a check-in or check-out code, to confirm you are at the dependant's home. We keep only how far you were from the home, and we do not track your location at any other time.",
        "Visit records for your dependants: check-in and check-out times, how the caregiver checked in and out (and their reason if they checked out without your code), the care tasks recorded, and caregivers' notes.",
        "Two recordings of 10 to 30 seconds made by the caregiver at each visit: the caregiver's voice, then the dependant's. You and the other family members linked to the dependant can listen to the dependant's recording.",
        "A voiceprint of your dependant's voice, made from about 30 seconds of their speech that you record once in the app.",
      ],
    },
    {
      heading: "Your dependant's consent",
      paragraphs: [
        'By registering or managing a dependant you confirm that you are authorised to share their details with Mzazi Care and, where they cannot give consent themselves, to consent on their behalf to location checks at their home, to audio being recorded during their visits, and to their voice being checked against their voiceprint.',
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
        "Mzazi Care supervisors can see everything described above, including each visit's voice check results, except that they cannot listen to the recordings. A caregiver assigned to a dependant can see what they need for the visit: the dependant's name, home location and care plan. The other family members linked to the same dependant can see your name, relationship, phone number and email address, so you can coordinate care. They cannot see your identity document.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        "Visit recordings are deleted after 90 days. Voice check results are kept with the visit records, as part of the care history. A dependant's voiceprint is kept while they receive care from Mzazi Care, replaced if it is recorded again, and deleted when they leave.",
      ],
    },
    voiceChecks('the caregiver and your dependant'),
    {
      heading: 'Your consent for location checks, audio and voice checks',
      paragraphs: [
        'Below these terms we ask for three separate consents, each with its own checkbox, given for yourself and on behalf of every dependant you register or are the primary contact for: to location being checked at check-in and check-out at their home, to audio being recorded during their visits, and to their voice being checked against their voiceprint. You need to give all three to use the app.',
        'Visits can only be scheduled for a dependant whose location consent is in place. To withdraw any consent for a dependant later, contact your Mzazi Care supervisor.',
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By ticking all three boxes and tapping Accept you confirm that you have read this notice, agree to these terms, and give all three consents above. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

/** The current document for an app's users - the one they must have accepted to use it. */
export const CURRENT_TERMS: Record<TermsDocumentType, TermsDocument> = {
  caregiver: caregiverTerms,
  family_member: familyMemberTerms,
};
