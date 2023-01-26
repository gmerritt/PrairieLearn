/* eslint-env browser,jquery */

(() => {
  function escapePath(path) {
    return path
      .replace(/^\//, '')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  class PLFileUpload {
    constructor(uuid, options) {
      this.uuid = uuid;
      this.files = [];
      this.acceptedFiles = options.acceptedFiles || [];
      this.acceptedFilesLowerCase = this.acceptedFiles.map((f) => f.toLowerCase());
      this.pendingFileDownloads = new Set();

      const elementId = '#file-upload-' + uuid;
      this.element = $(elementId);
      if (!this.element) {
        throw new Error('File upload element ' + elementId + ' was not found!');
      }

      if (options.submittedFileNames) {
        this.downloadExistingFiles(options.submittedFileNames).then(() => {
          this.syncFilesToHiddenInput();
        });
      }

      // We need to render after we start loading the existing files so that we
      // can pick up the right values from `pendingFileDownloads`.
      this.initializeTemplate();
    }

    async downloadExistingFiles(fileNames) {
      const submissionFilesUrl = this.element.data('submission-files-url');
      fileNames.forEach((file) => this.pendingFileDownloads.add(file));

      await Promise.all(
        fileNames.map(async (file) => {
          const escapedFileName = escapePath(file);
          const path = `${submissionFilesUrl}/${escapedFileName}`;
          const res = await fetch(path, { method: 'GET' });
          if (!res.ok) {
            // TODO: better error handling
            throw new Error(`Could not download file ${file}`);
          }

          // Avoid race condition with student initiated upload. If the student
          // added a file while this was loading, the file name would have been
          // removed from the list of pending downloads, so we can just ignore
          // the result.
          if (this.pendingFileDownloads.has(file)) {
            this.addFileFromUrl(file, await res.blob());
          }
        })
      );
    }

    /**
     * Initializes the file upload zone on the question.
     */
    initializeTemplate() {
      const $dropTarget = this.element.find('.upload-dropzone');

      $dropTarget.dropzone({
        url: '/none',
        autoProcessQueue: false,
        accept: (file, done) => {
          // fuzzy case match
          const fileNameLowerCase = file.name.toLowerCase();
          if (this.acceptedFilesLowerCase.includes(fileNameLowerCase)) {
            return done();
          }
          return done('invalid file');
        },
        addedfile: (file) => {
          // fuzzy case match
          const fileNameLowerCase = file.name.toLowerCase();
          if (!this.acceptedFilesLowerCase.includes(fileNameLowerCase)) {
            this.addWarningMessage(
              '<strong>' +
                file.name +
                '</strong>' +
                ' did not match any accepted file for this question.'
            );
            return;
          }
          const acceptedFilesIdx = this.acceptedFilesLowerCase.indexOf(fileNameLowerCase);
          const acceptedName = this.acceptedFiles[acceptedFilesIdx];
          this.addFileFromUrl(acceptedName, file);
        },
      });

      this.renderFileList();
    }

    /**
     * Syncs the internal file array to the hidden input element
     * @type {[type]}
     */
    syncFilesToHiddenInput() {
      this.element.find('input').val(JSON.stringify(this.files));
    }

    addFileFromUrl(name, url) {
      this.pendingFileDownloads.delete(name);

      var reader = new FileReader();
      reader.onload = (e) => {
        var dataUrl = e.target.result;

        var commaSplitIdx = dataUrl.indexOf(',');
        if (commaSplitIdx === -1) {
          this.addWarningMessage('<strong>' + name + '</strong>' + ' is empty, ignoring file.');
          return;
        }

        // Store the file as base-64 encoded data
        var base64FileData = dataUrl.substring(commaSplitIdx + 1);
        this.saveSubmittedFile(name, base64FileData);
        this.renderFileList();
        // Show the preview for the newly-uploaded file
        this.element.find(`li[data-file="${name}"] .file-preview`).addClass('in');
      };

      reader.readAsDataURL(url);
    }

    /**
     * Saves or updates the given file.
     * @param  {String} name     Name of the file
     * @param  {String} contents The file's base64-encoded contents
     */
    saveSubmittedFile(name, contents) {
      var idx = this.files.findIndex((file) => file.name === name);
      if (idx === -1) {
        this.files.push({
          name: name,
          contents: contents,
        });
      } else {
        this.files[idx].contents = contents;
      }

      this.syncFilesToHiddenInput();
    }

    /**
     * Gets the base64-encoded contents of a file with the given name.
     * @param  {String} name The desired file
     * @return {String}      The file's contents, or null if the file was not found
     */
    getSubmittedFileContents(name) {
      const file = this.files.find((file) => file.name === name);
      return file ? file.contents : null;
    }

    /**
     * Generates markup to show the status of the uploaded files, including
     * previews of files as appropriate.
     *
     * Imperative DOM manipulations can rot in hell.
     */
    renderFileList() {
      var $fileList = this.element.find('.file-upload-status .card ul.list-group');

      // Save which cards are currently expanded
      var expandedFiles = [];
      $fileList.children().each(function () {
        var fileName = $(this).attr('data-file');
        if (fileName && $(this).find('.file-preview').hasClass('in')) {
          expandedFiles.push(fileName);
        }
      });

      $fileList.html('');

      var uuid = this.uuid;
      var that = this;

      this.acceptedFiles.forEach((fileName, index) => {
        var isExpanded = expandedFiles.includes(fileName);
        var fileData = that.getSubmittedFileContents(fileName);

        var $file = $('<li class="list-group-item" data-file="' + fileName + '"></li>');
        var $fileStatusContainer = $(
          '<div class="file-status-container collapsed" data-toggle="collapse" data-target="#file-preview-' +
            uuid +
            '-' +
            index +
            '"></div>'
        );
        if (isExpanded) {
          $fileStatusContainer.removeClass('collapsed');
        }
        if (fileData) {
          $fileStatusContainer.addClass('has-preview');
        }
        $file.append($fileStatusContainer);
        var $fileStatusContainerLeft = $('<div class="file-status-container-left"></div>');
        $fileStatusContainer.append($fileStatusContainerLeft);
        if (this.pendingFileDownloads.has(fileName)) {
          $fileStatusContainerLeft.append(
            '<i class="file-status-icon fas fa-spinner fa-spin" aria-hidden="true"></i>'
          );
        } else if (fileData) {
          $fileStatusContainerLeft.append(
            '<i class="file-status-icon fa fa-check-circle" style="color: #4CAF50;" aria-hidden="true"></i>'
          );
        } else {
          $fileStatusContainerLeft.append(
            '<i class="file-status-icon far fa-circle" aria-hidden="true"></i>'
          );
        }
        $fileStatusContainerLeft.append(fileName);
        if (this.pendingFileDownloads.has(fileName)) {
          // Even though we're *technically* in the middle of a download, we'll
          // present it as "uploading" to the user, since that's what they're
          // expecting.
          $fileStatusContainerLeft.append('<p class="file-status">uploading...</p>');
        } else if (!fileData) {
          $fileStatusContainerLeft.append('<p class="file-status">not uploaded</p>');
        } else {
          $fileStatusContainerLeft.append('<p class="file-status">uploaded</p>');
        }
        if (fileData) {
          var download =
            '<a download="' +
            fileName +
            '" class="btn btn-outline-secondary btn-sm mr-1" onclick="event.stopPropagation();" href="data:application/octet-stream;base64,' +
            fileData +
            '">Download</a>';

          var $preview = $(
            '<div class="file-preview collapse" id="file-preview-' +
              uuid +
              '-' +
              index +
              '"><pre class="bg-dark text-white rounded p-3 mb-0"><code></code></pre></div>'
          );
          if (isExpanded) {
            $preview.addClass('in');
          }
          try {
            var fileContents = that.b64DecodeUnicode(fileData);
            if (!that.isBinary(fileContents)) {
              $preview.find('code').text(fileContents);
            } else {
              $preview.find('code').text('Binary file not previewed.');
            }
          } catch (e) {
            var img = $('<img style="max-width: 100%"/>')
              .on('load', () => $preview.find('code').html(img))
              .on('error', () =>
                $preview
                  .find('code')
                  .text('Content preview is not available for this type of file.')
              )
              .attr('src', 'data:application/octet-stream; base64, ' + fileData);
          }
          $file.append($preview);
          $fileStatusContainer.append(
            '<div class="file-status-container-right">' +
              download +
              '<button type="button" class="btn btn-outline-secondary btn-sm file-preview-button"><span class="file-preview-icon fa fa-angle-down"></span></button></div>'
          );
        }

        $fileList.append($file);
      });
    }

    addWarningMessage(message) {
      var $alert = $(
        '<div class="alert alert-warning alert-dismissible" role="alert"><button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button></div>'
      );
      $alert.append(message);
      this.element.find('.messages').append($alert);
    }

    /**
     * Checks if the given file contents should be treated as binary or
     * text. Uses the same method as git: if the first 8000 bytes contain a
     * NUL character ('\0'), we consider the file to be binary.
     * http://stackoverflow.com/questions/6119956/how-to-determine-if-git-handles-a-file-as-binary-or-as-text
     * @param  {String}  decodedFileContents File contents to check
     * @return {Boolean}                     If the file is recognized as binary
     */
    isBinary(decodedFileContents) {
      var nulIdx = decodedFileContents.indexOf('\0');
      var fileLength = decodedFileContents.length;
      return nulIdx !== -1 && nulIdx <= (fileLength <= 8000 ? fileLength : 8000);
    }

    /**
     * To support unicode strings, we use a method from Mozilla to decode:
     * first we get the bytestream, then we percent-encode it, then we
     * decode that to the original string.
     * https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding#The_Unicode_Problem
     * @param  {String} str the base64 string to decode
     * @return {String}     the decoded string
     */
    b64DecodeUnicode(str) {
      // Going backwards: from bytestream, to percent-encoding, to original string.
      return decodeURIComponent(
        atob(str)
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
    }
  }

  window.PLFileUpload = PLFileUpload;
})();
