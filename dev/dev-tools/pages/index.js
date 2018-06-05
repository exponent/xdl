import * as React from 'react';
import gql from 'graphql-tag';
import { ApolloProvider, Query } from 'react-apollo';

import * as Constants from 'app/common/constants';
import * as Strings from 'app/common/strings';
import * as State from 'app/common/state';
import createApolloClient from 'app/common/createApolloClient';
import { initStore } from 'app/common/store';

import withRedux from 'app/higher-order/withRedux';

import Root from 'app/components/Root';
import ProjectManager from 'app/components/ProjectManager';

const query = gql`
  query IndexPageQuery {
    currentProject {
      id
      manifestUrl
      settings {
        hostType
      }
      config {
        name
        description
        slug
        githubUrl
      }
      sources {
        id
        name
        messages {
          count
          unreadCount
          nodes {
            id
            msg
            time
            level
          }
          pageInfo {
            lastReadCursor
          }
        }
      }
      messages {
        pageInfo {
          lastCursor
        }
      }
    }
    userSettings {
      id
      sendTo
    }
    projectManagerLayout {
      id
      selected {
        id
      }
      sources {
        id
      }
    }
    processInfo {
      networkStatus
      isAndroidSimulatorSupported
      isIosSimulatorSupported
    }
    user {
      username
    }
  }
`;

const projectPollQuery = gql`
  query IndexPageQuery {
    currentProject {
      id
      manifestUrl
      settings {
        hostType
      }
      config {
        name
        description
        slug
        githubUrl
      }
    }
    userSettings {
      id
      sendTo
    }
    projectManagerLayout {
      id
      selected {
        id
      }
      sources {
        id
      }
    }
    processInfo {
      networkStatus
      isAndroidSimulatorSupported
      isIosSimulatorSupported
    }
  }
`;

const subscriptionQuery = gql`
  subscription MessageSubscription($after: String) {
    messages(after: $after) {
      type
      cursor
      node {
        id
        msg
        time
        level
        source {
          id
        }
      }
    }
  }
`;

const createSourceQuery = typename => gql`
  fragment ${typename}Fragment on ${typename} {
    __typename
    id
    messages {
      __typename
      count
      unreadCount
      nodes {
        id
        __typename
        msg
        time
        level
      }
      pageInfo {
        lastReadCursor
      }
    }
  }
`;

@withRedux(initStore, state => state)
class IndexPageContents extends React.Component {
  _handleDeviceSelect = options => State.sourceSelect(options, this.props);
  _handleSectionDrag = options => State.sourceSwap(options, this.props);
  _handleSectionSelect = options => State.sectionSelect(options, this.props);
  _handleSectionDismiss = () => State.sectionClear(this.props);
  _handleChangeSectionCount = count => State.sectionCount({ count }, this.props);
  _handleUpdateState = options => State.update(options, this.props);
  _handleSimulatorClickIOS = () => State.openSimulator('IOS', this.props);
  _handleSimulatorClickAndroid = () => State.openSimulator('ANDROID', this.props);
  _handleHostTypeClick = hostType => State.setProjectSettings({ hostType }, this.props);
  _handlePublishProject = options => State.publishProject(options, this.props);
  _handleSubmitPhoneNumberOrEmail = async () =>
    await State.sendProjectUrl(this.props.recipient, this.props);

  componentDidMount() {
    if (this.props.data.userSettings.sendTo) {
      this._handleUpdateState({
        recipient: this.props.data.userSettings.sendTo,
      });
    }

    const subscriptionObservable = this.props.client.subscribe({
      query: subscriptionQuery,
      variables: {
        after: this.props.data.currentProject.messages.pageInfo.lastCursor,
      },
    });
    this.querySubscription = subscriptionObservable.subscribe({
      next: result => this.updateCurrentData(result),
      // error: this.updateError,
    });
    this.pollingObservable = this.props.client.watchQuery({
      query: projectPollQuery,
    });
    this.pollingObservable.startPolling(60000);
    this.updateTitle();
  }

  componentDidUpdate() {
    this.updateTitle();
  }

  componentWillUnmount() {
    if (this.querySubscription) {
      this.querySubscription.unsubscribe();
    }
    if (this.pollingObservable) {
      this.pollingObservable.unsubscribe();
    }
  }

  updateCurrentData(result) {
    if (result.data.messages.type === 'ADDED') {
      const hostType = this.props.data.currentProject.settings.hostType;
      const typename = result.data.messages.node.__typename;
      if (
        (hostType === 'tunnel' && typename === 'TunnelReady') ||
        (hostType !== 'tunnel' && typename === 'MetroInitializeStarted')
      ) {
        this.pollingObservable.refetch();
      }
      this.addNewMessage(result.data.messages);
    } else if (result.data.messages.type === 'DELETED') {
      this.removeMessage(result.data.messages.node);
    }
  }

  addNewMessage({ cursor, node: message }) {
    const typename = message.source.__typename;
    const fragment = createSourceQuery(typename);
    const id = message.source.id;
    let existingSource;
    try {
      existingSource = this.props.client.readFragment({ id, fragment });
    } catch (e) {
      // XXX(@fson): refetching all data
      this.props.refetch();
      return;
    }

    let unreadCount = existingSource.messages.unreadCount;
    let lastReadCursor = existingSource.messages.pageInfo.lastReadCursor;
    const { currentProject, projectManagerLayout } = this.props.data;
    const { sections } = getSections(currentProject, projectManagerLayout);
    if (!document.hidden && sections.find(section => section.id === id)) {
      lastReadCursor = cursor;
      State.updateLastRead({ sourceId: id, sourceType: typename, lastReadCursor }, this.props);
    } else {
      unreadCount += 1;
    }

    const newMessages = {
      __typename: 'MessageConnection',
      unreadCount,
      count: existingSource.messages.count + 1,
      nodes: [...existingSource.messages.nodes, message],
      pageInfo: {
        __typename: 'PageInfo',
        lastReadCursor,
      },
    };
    this.props.client.writeFragment({
      id,
      fragment,
      data: {
        id,
        __typename: typename,
        messages: newMessages,
      },
    });
  }

  removeMessage(message) {
    const typename = message.source.__typename;
    const fragment = createSourceQuery(typename);
    const id = message.source.id;
    let existingSource;
    try {
      existingSource = this.props.client.readFragment({ id, fragment });
    } catch (e) {
      // XXX(@fson): refetching all data
      this.props.refetch();
      return;
    }
    const newNodes = existingSource.messages.nodes.filter(
      existingMessage => existingMessage.id !== message.id
    );
    const newMessages = {
      __typename: 'MessageConnection',
      count: newNodes.length,
      nodes: newNodes,
    };
    this.props.client.writeFragment({
      id,
      fragment,
      data: {
        id,
        __typename: typename,
        messages: newMessages,
      },
    });
  }

  getTotalUnreadCount() {
    const { currentProject } = this.props.data;
    let count = 0;
    currentProject.sources.forEach(source => {
      count += source.messages.unreadCount;
    });
    return count;
  }

  updateTitle() {
    if (this.props.data) {
      const { name } = this.props.data.currentProject.config;
      const unreadCount = this.getTotalUnreadCount();
      let title;
      if (unreadCount > 0) {
        title = `(${unreadCount}) ${name} on Expo Developer Tools`;
      } else {
        title = `${name} on Expo Developer Tools`;
      }
      if (title !== document.title) {
        document.title = title;
      }
    }
  }

  render() {
    const {
      data: { currentProject, projectManagerLayout, processInfo, user },
      loading,
      error,
    } = this.props;

    const { sections, sources } = getSections(currentProject, projectManagerLayout);
    const count = sections.length;
    const selectedId = projectManagerLayout.selected && projectManagerLayout.selected.id;

    return (
      <Root>
        <ProjectManager
          loading={loading}
          error={error}
          project={currentProject}
          user={user}
          processInfo={processInfo}
          renderableSections={sections}
          sections={sources}
          count={count}
          userAddress={this.props.userAddress}
          selectedId={selectedId}
          recipient={this.props.recipient}
          dispatch={this.props.dispatch}
          isPublishing={this.props.isPublishing}
          isActiveDeviceAndroid={this.props.isActiveDeviceAndroid}
          isActiveDeviceIOS={this.props.isActiveDeviceIOS}
          onPublishProject={this._handlePublishProject}
          onHostTypeClick={this._handleHostTypeClick}
          onSimulatorClickIOS={this._handleSimulatorClickIOS}
          onSimulatorClickAndroid={this._handleSimulatorClickAndroid}
          onSectionDrag={this._handleSectionDrag}
          onSectionDismiss={this._handleSectionDismiss}
          onSectionSelect={this._handleSectionSelect}
          onSubmitPhoneNumberOrEmail={this._handleSubmitPhoneNumberOrEmail}
          onChangeSectionCount={this._handleChangeSectionCount}
          onDeviceSelect={this._handleDeviceSelect}
          onUpdateState={this._handleUpdateState}
        />
      </Root>
    );
  }
}

function getSections(currentProject, projectManagerLayout) {
  const sources = currentProject.sources.filter(source => {
    return source.__typename !== 'Issues' || source.messages.count > 0;
  });
  let sections = projectManagerLayout.sources
    .map(({ id }) => currentProject.sources.find(source => source.id === id))
    .filter(section => section);
  if (sections.length === 0) {
    sections = [sources.find(source => source.__typename !== 'Issues')];
  }
  return {
    sections,
    sources,
  };
}

export default class IndexPage extends React.Component {
  client = process.browser ? createApolloClient() : null;

  render() {
    if (!this.client) {
      // Server-side rendering for static HTML export.
      return null;
    }

    return (
      <ApolloProvider client={this.client}>
        <Query query={query}>
          {result => {
            if (!result.loading && !result.error) {
              return <IndexPageContents {...result} />;
            } else {
              // TODO(freiksenet): fix loading states
              return null;
            }
          }}
        </Query>
      </ApolloProvider>
    );
  }
}