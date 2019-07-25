process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://6688f14ce7294ba7b6d573218c6d7560@sentry.cozycloud.cc/112'

const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log
} = require('cozy-konnector-libs')

const PassThrough = require('stream').PassThrough

const querystring = require('querystring')
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very useful for
  // debugging but very verbose. That is why it is commented out by default
  //debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Parsing list of documents')
  const documents = await parseDocuments()

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['cesml'],
    contentType: 'application/pdf'
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return signin({
    url: `https://moncompte.cesml.com/Portail/fr-FR/Connexion/Login`,
    formSelector: 'form',
    formData: { Login: username, MotDePasse: password },
    // the validate function will check if the login request was a success. Every website has
    // different ways respond: http status code, error message in html ($), http redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $) => {
      // The login in toscrape.com always works excepted when no password is set
      if ($(`a[href='/Portail/fr-FR/Usager/Home/Logout']`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        return false
      }
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments() {
  var nDepart = 0
  var tabDocs = []
  // Tant qu'il y a des documents
  let bTrue = true
  while (bTrue) {
    log('info', 'Récupération des factures')
    // On récupère les factures en commencant à nDepart * 10 (on récupère 10 factures à chaque fois)
    var tabFactures = await GetFactures(nDepart * 10)

    // Ajoute toutes les factures dans le tableau
    tabDocs.push(...tabFactures)

    // Si on n'a pas récupéré les 10 factures, c'est qu'il y en a moins, donc c'est qu'on a fini
    if (tabFactures.length < 10) break

    // Incrémente le départ pour le prochain tour...
    nDepart++
  }

  return tabDocs
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.trim())
}

async function GetFactures(nDepart) {
  // Les paramètres de la table à récupérer
  var form = {
    sEcho: 1,
    iColumns: 11,
    sColumns: ',,,,,,,,,,',
    iDisplayStart: nDepart,
    iDisplayLength: 10,
    mDataProp_0: 0,
    bSortable_0: true,
    mDataProp_1: 1,
    bSortable_1: true,
    mDataProp_2: 2,
    bSortable_2: true,
    mDataProp_3: 3,
    bSortable_3: true,
    mDataProp_4: 4,
    bSortable_4: true,
    mDataProp_5: 5,
    bSortable_5: true,
    mDataProp_6: 6,
    bSortable_6: true,
    mDataProp_7: 7,
    bSortable_7: true,
    mDataProp_8: 8,
    bSortable_8: true,
    mDataProp_9: 9,
    bSortable_9: false,
    mDataProp_10: 10,
    bSortable_10: false,
    iSortCol_0: 1,
    sSortDir_0: 'desc',
    iSortCol_1: 8,
    sSortDir_1: 'desc',
    iSortingCols: 2
  }

  // Transforme l'objet JSON en chaîne url-encodée
  var formData = querystring.stringify(form)
  // La taille du contenu
  var contentLength = formData.length
  var oObjet
  // Envoie la requête
  await request(
    {
      headers: {
        'Content-Length': contentLength,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      uri:
        'https://moncompte.cesml.com/Portail/fr-FR/Usager/Abonnement/AjaxFactureSynchros?EstAcompte=false',
      body: formData,
      method: 'POST'
    },
    function(error, response, body) {
      // Stocke l'objet JSON parsé
      oObjet = JSON.parse(body)
    }
  )

  var tabDocs = []

  for (var i = 0; i < oObjet.aaData.length; i++) {
    // On déclare l'objet dans la boucle car la déclaration crée un nouvel objet
    // Si on ne crée pas l'objet dans la boucle, on ajoute systématiquement le même objet (référence)
    // Et on modifie toujours le meme objet
    var oUnDoc = {}

    oUnDoc.reference = oObjet.aaData[i][0]
    oUnDoc.date = parseDate(oObjet.aaData[i][1])
    oUnDoc.filename = normalizeFileName(
      oUnDoc.date,
      oObjet.aaData[i][4],
      oUnDoc.reference
    )
    oUnDoc.amount = normalizePrice(oObjet.aaData[i][4])
    oUnDoc.currency = '€'
    oUnDoc.vendor = 'CESML'

    // l'objet avec les metadata
    oUnDoc.metadata = {}
    oUnDoc.metadata.importDate = new Date()
    oUnDoc.metadata.version = 1

    // Le ntaille -1 est vrai, c'est que la facture est téléchargeable
    if (oObjet.aaData[i][oObjet.aaData[i].length - 2] == true) {
      formData = '{"id":' + oObjet.aaData[i][14] + '}'
      contentLength = formData.length
      await request(
        {
          uri:
            'https://moncompte.cesml.com/Portail/fr-FR/Usager/Abonnement/StoreFactureId',
          body: formData,
          method: 'POST',
          headers: {
            'Content-Length': contentLength,
            'Content-Type': 'application/json'
          }
        },
        function(error, response, body) {
          log('debug', response)
          log('debug', body)
          log('debug', error)
        }
      )
    }

    log('info', oUnDoc.filename)
    oUnDoc.filestream = await request(
      'https://moncompte.cesml.com/Portail/fr-FR/Usager/Abonnement/TelechargerFacture'
    ).pipe(new PassThrough())

    // Ajoute les éléments au tableau
    tabDocs.push(oUnDoc)
  }

  return tabDocs
}

// Convertit une date au format chaîne en objet Date JS
function parseDate(sDate) {
  // Splitte la date sur le / (la date est au format : JJ/MM/AAAA)
  let tabChiffres = sDate.split('/')
  // Recrée une date JS
  return new Date(tabChiffres[2] + '-' + tabChiffres[1] + '-' + tabChiffres[0])
}

// Convert a Date object to a ISO date string
function formatDate(date) {
  let year = date.getFullYear()
  let month = date.getMonth() + 1
  let day = date.getDate()
  if (month < 10) {
    month = '0' + month
  }
  if (day < 10) {
    day = '0' + day
  }
  return `${year}-${month}-${day}`
}

function normalizeFileName(dDate, mMontant, sReference) {
  /*2018-01-02_edf_35.50€_345234.pdf
YYYY-MM-DD_vendor_amount.toFixed(2)currency_reference.pdf
*/
  return formatDate(dDate) + '_CESML_' + mMontant + '€_' + sReference + '.pdf'
}
