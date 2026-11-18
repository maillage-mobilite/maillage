// Identité du service : un seul endroit à modifier le jour où le nom définitif est choisi
// (repris aussi, en dur, dans public/a-propos.html, index.html et widget.html).
export const BRAND = {
  name: 'Maillage',
  /** éditeur, pour « Signaler un problème avec l'application » et la page À propos */
  contact: 'contact@tuatam.fr',
  about: './a-propos.html',
  /** mention courte, en bas des écrans */
  disclaimer: (territory: string) =>
    `Service indépendant, construit à partir des données publiées en open data par les réseaux. Il n'est affilié ni au réseau de transport ni à ${territory} : en cas de doute, l'information officielle du réseau fait foi.`,
}
