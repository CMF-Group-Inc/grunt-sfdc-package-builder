/*
 * grunt-sfdc-package-builder
 * https://github.com/CMF-Group-Inc/grunt-sfdc-package-builder
 *
 * Copyright (c) 2018 Kevin C. Gall, CM&F Group Inc.
 * Licensed under the MIT license.
 */

'use strict';

const noWildcardTypesLib = require('./lib/metadata-access.js').noWildcardTypes;
const xmlBuilder = require('xmlbuilder');

module.exports = function(grunt) {
  const util = require('./lib/utils')(grunt);

  // Please see the Grunt documentation for more information regarding task
  // creation: http://gruntjs.com/creating-tasks

  grunt.registerMultiTask('sfdc_package_builder', 'Package.xml builder for SFDC platform as grunt task', function() {
    const done = this.async();

    // Merge task-specific and/or target-specific options with these defaults.
    var options = this.options({
      all: false,
      useWildcards: false,
      metaWsdlLoc: `${__dirname}/../data/metadata-wsdl.xml`,
      partnerWsdlLoc: `${__dirname}/../data/partner-wsdl.xml`,
      excludeManaged: false,
      clearCache: false,
      dest: 'package.xml',
      apiVersion: '44.0',
    });

    Object.assign(options, this.data);

    if (options.excludeManaged === false) options.excludeManaged = [];

    if (!options.login) {
      grunt.warn('Login credentials missing');
      return;
    }

    let creds;
    try {
      if (typeof options.login === 'string') {
        creds = grunt.file.readJSON(options.login);
      } else {
        creds = options.login;
      }
    } catch (err) {
      grunt.warn('Unable to read login');
      return;
    }

    //check that there's something for us to build
    if (!options.all && !options.included) {
      grunt.warn('No metadata requested - specify either "all" or specific metadata in "included"');
      return;
    }

    const partnerSoapOptions = {};
    if (!!creds.url) {
      partnerSoapOptions.endpoint = creds.url + '/services/Soap/u/' + options.apiVersion;
    }

    let metaClient;
    let partnerClient;

    const wildcardTypes = []; //types we will retrieve using wildcard
    const itemizedTypes = {}; //types that we will retrieve as itemized entries
    const folderNameToType = new Map();
    let doneCode = 0;

    //get session data and metadata soap client
    Promise.all([
      util.getPartnerClient(creds, options.partnerWsdlLoc, partnerSoapOptions),
      util.getMetaClient(options.metaWsdlLoc)
    ])
    //get metadata describe
    .then((data) => {
      partnerClient = data[0];
      metaClient = data[1];

      return util.withValidSession(partnerClient, metaClient,
        (innerMetaClient) => util.describeMetadata(innerMetaClient, options.apiVersion));
    })
    // identify metadata to grab based on user options
    // then send listMetadata query
    .then((metaDescribe) => {
      let typesToQuery = []; //types we will retrieve by itemizing members

      // Putting metadata types requested by config into 2 buckets:
      // wildcard queries and individual queries
      const noWildcardsForVersion = noWildcardTypesLib[options.apiVersion];
      for (let meta of metaDescribe.metadataObjects) {
        if (includeMetadataType(options, meta)) {
          if (options.useWildcards
              && !noWildcardsForVersion.includes(meta.xmlName)
              && (options.excludeManaged === true
                || options.excludeManaged.includes(meta.xmlName)
                || options.excludeManaged.includes(meta.directoryName))) {
            wildcardTypes.push(meta);
          } else {
            typesToQuery.push(meta);
          }
        }
      }
      
      const listQuerySets = [];
      let counter = 0;
      let querySet;
      typesToQuery.forEach((meta) => {
        if (counter % 3 == 0) {
          querySet = [];
          listQuerySets.push(querySet);
        }

        let metaTypeName = meta.xmlName;
        let typeQuery = {};
        if (meta.inFolder) {
          if (meta.xmlName === 'EmailTemplate') {
            metaTypeName = 'EmailFolder';
          } else {
            metaTypeName += 'Folder';
          }

          folderNameToType.set(metaTypeName, meta.xmlName);
        }
        typeQuery.type = metaTypeName;

        querySet.push(typeQuery);
        itemizedTypes[meta.xmlName] = []; //init list
        counter++;
      });

      return util.withValidSession(partnerClient, metaClient, (innerMetaClient) => {
        const listQueryRequests = listQuerySets.map((queryList) => {
          return innerMetaClient.listMetadataAsync({
            queries: queryList,
            asOfVersion: options.apiVersion
          });
        });

        //first element of returned promise data array is the wildcard types
        return Promise.all(listQueryRequests);
      });
    })
    //handle list results: We need to recurse through folder metadata types
    //to retrieve folder contents as well
    .then((listResults) => {
      let folderContentQueries = [];
      let currentQuery;
      let counter = 0;

      listResults.forEach((res) => {
        if (!res[0]) return; //if no elements for type, nothing to do here!

        res[0].result.forEach((item) => {
          // TODO: filter out managed package items here

          if (folderNameToType.has(item.type)) {
            if (counter % 3 === 0) {
              currentQuery = [];
              folderContentQueries.push(currentQuery);
            }
            currentQuery.push(
              {type: folderNameToType.get(item.type), folder: item.fullName}
            );

            counter++;
          } else {
            if (includeMetadataItem(options, item)) {
              itemizedTypes[item.type].push(item);
            }
          }
        });
      });

      const contentQueryRequests = folderContentQueries.map((current) => {
        return metaClient.listMetadataAsync({
          queries: current,
          asOfVersion: options.apiVersion
        });
      });

      return Promise.all(contentQueryRequests);
    })
    //We have all our itemized data. Build the package.xml
    .then((listResults) => {
      //first grab any content items from folders
      listResults.forEach((queryResult) => {
        if (!queryResult[0]) return; //no elements for folder, nothing to do!
        queryResult[0].result.forEach((contentItem) => {
          //filter managed items if applicable
          if (includeMetadataItem(options, contentItem)) {
            itemizedTypes[contentItem.type].push(contentItem);            
          }
        });
      });

      const pkg = xmlBuilder.create('Package', {encoding: 'UTF-8'})
        .att('xmlns', 'http://soap.sforce.com/2006/04/metadata');

      //Loop through itemized list items: log and add to package
      grunt.log.debug('Itemized Metadata:');
      for (let itemType in itemizedTypes) {
        const itemList = itemizedTypes[itemType];
        grunt.log.debug(`Type ${itemType}`);

        if (itemList.length === 0) continue;

        const typeElement = pkg.ele('types');
        itemList.forEach((item) => {
          grunt.log.debug(`  ${item.fullName}`);

          typeElement.ele('members').text(item.fullName);
        });

        typeElement.ele('name').text(itemType);
      }

      for (let wildcard of wildcardTypes) {
        pkg.ele({
          types: {
            members: '*',
            name: wildcard.xmlName
          }
        });
      }

      pkg.ele('version').text(options.apiVersion);

      //write package.xml
      grunt.file.write(options.dest, pkg.end({
        pretty: true,
        indent: '  ',
        newline: '\n',
      }));
    })
    //Log error and exit
    .catch((err) => {
      util.logErr(err);
      grunt.warn('Error');

      doneCode = 6;
    })
    .finally(() => {
      if (options.clearCache) {
        grunt.file.delete('.grunt/sfdc_package_builder');
      }

      done(doneCode);
    });

  });
};

function includeMetadataType(options, metaDesc) {
  const all = !!options.all;
  const included = !!options.included && 
    (options.included.includes(meta.xmlName)
      || options.included.includes(meta.directoryName));
  const excluded = !!options.excluded && 
    (options.excluded.includes(meta.xmlName)
      || options.excluded.includes(meta.directoryName));

  return (all && !excluded) || included;
}

function includeMetadataItem(options, item) {
  if (item.manageableState !== 'unmanaged') {
    if (options.excludeManaged === true ||
        (Array.isArray(options.excludeManaged) && options.excludeManaged.includes(item.type))) {
      return false;
    }
  }

  return true;
}

class FolderData {
  constructor(metadataType, folderName) {
    this.metadataType = metadataType;
    this.folderName = folderName;
    this.fileLocations = [];
  }
}