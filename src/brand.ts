// Identité du service. Nom et contact viennent de brand.json, seul fichier à modifier le jour où le nom
// définitif est choisi (les pages HTML et le serveur de l'espace mairie le lisent aussi : EXPLOITATION.md, section 9).
import marque from '../brand.json'

export const BRAND = {
  name: marque.nom,
  /** éditeur, pour « Signaler un problème avec l'application » et la page À propos */
  contact: marque.contact,
  about: './a-propos.html',
  /** mention courte, en bas des écrans */
  disclaimer: (territory: string) =>
    `Service indépendant, construit à partir des données publiées en open data par les réseaux. Il n'est affilié ni au réseau de transport ni à ${territory} : en cas de doute, l'information officielle du réseau fait foi.`,
}
