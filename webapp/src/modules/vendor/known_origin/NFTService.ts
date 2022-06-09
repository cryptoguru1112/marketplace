import { ethers } from 'ethers'
import { ListingStatus, Network, Order } from '@dcl/schemas'
import { Wallet } from 'decentraland-dapps/dist/modules/wallet/types'
import { ERC721__factory } from '../../../contracts'
import { NFT, NFTsFetchParams, NFTsCountParams } from '../../nft/types'
import { Account } from '../../account/types'
import { getNFTId } from '../../nft/utils'
import { TokenConverter } from '../TokenConverter'
import { MarketplacePrice } from '../MarketplacePrice'
import { NFTService as NFTServiceInterface } from '../services'
import { getOriginURL } from '../utils'
import { getContractNames, VendorName } from '../types'
import { getContract, getCurrentSigner } from '../../contract/utils'
import { NFTsFetchFilters } from './nft/types'
import { EditionFragment } from './edition/fragments'
import { TokenFragment } from './token/fragments'
import { editionAPI } from './edition/api'
import { tokenAPI } from './token/api'
import { MAX_QUERY_SIZE } from './api'
import { AssetType } from './types'
import { config } from '../../../config'

type Fragment = TokenFragment | EditionFragment

export class NFTService
  implements NFTServiceInterface<VendorName.KNOWN_ORIGIN> {
  private tokenConverter: TokenConverter
  private marketplacePrice: MarketplacePrice
  private oneEthInWei: ethers.BigNumber

  constructor() {
    this.tokenConverter = new TokenConverter()
    this.marketplacePrice = new MarketplacePrice()
    this.oneEthInWei = ethers.BigNumber.from('1000000000000000000') // 10 ** 18
  }

  async fetch(params: NFTsFetchParams, filters?: NFTsFetchFilters) {
    const fragments = await this.getAPI(filters).fetch(params)
    const [total, oneEthInMANA] = await Promise.all([
      this.count(params, filters),
      this.getOneEthInMANA()
    ])

    const nfts: NFT<VendorName.KNOWN_ORIGIN>[] = []
    const accounts: Account[] = []
    const orders: Order[] = []

    for (const fragment of fragments) {
      const nft = this.toNFT(fragment)

      if (fragment.type === AssetType.EDITION) {
        const order = this.toOrder(fragment, oneEthInMANA)

        nft.activeOrderId = order.id

        orders.push(order)
      }

      let account = accounts.find(account => account.id === nft.owner)
      if (!account) {
        account = this.toAccount(nft.owner)
      }
      account.nftIds.push(nft.id)

      nfts.push(nft)
      accounts.push(account)
    }

    return [nfts, accounts, orders, total] as const
  }

  async count(countParams: NFTsCountParams, filters?: NFTsFetchFilters) {
    const params: NFTsFetchParams = {
      ...countParams,
      first: MAX_QUERY_SIZE,
      skip: 0
    }
    if (!filters) {
      const [editionCount, tokenCount] = await Promise.all([
        tokenAPI.count(params),
        editionAPI.count(params)
      ])
      return editionCount + tokenCount
    } else {
      return this.getAPI(filters).count(params)
    }
  }

  async fetchOne(_contractAddress: string, tokenId: string) {
    const fragment = await this.getAPI().fetchOne(tokenId)
    const oneEthInMANA = await this.getOneEthInMANA()

    const nft = this.toNFT(fragment)
    let order: Order | undefined

    if (fragment.type === AssetType.EDITION) {
      order = this.toOrder(fragment, oneEthInMANA)

      nft.activeOrderId = order.id
    }

    return [nft, order] as const
  }

  async transfer(
    wallet: Wallet | null,
    toAddress: string,
    nft: NFT<VendorName.KNOWN_ORIGIN>
  ): Promise<string> {
    if (!wallet) {
      throw new Error('Invalid address. Wallet must be connected.')
    }
    const from = wallet.address
    const to = toAddress

    const erc721 = ERC721__factory.connect(
      nft.contractAddress,
      await getCurrentSigner()
    )

    const transaction = await erc721.transferFrom(from, to, nft.tokenId)

    return transaction.hash
  }

  toNFT(fragment: Fragment): NFT<VendorName.KNOWN_ORIGIN> {
    const tokenId = fragment.id
    const { name, description, image } = fragment.metadata

    const contractNames = getContractNames()

    const contractAddress = getContract({
      name: contractNames.DIGITAL_ASSET
    }).address

    return {
      id: getNFTId(contractAddress, tokenId),
      tokenId,
      contractAddress,
      activeOrderId: '',
      owner: this.getOwner(fragment),
      name,
      image,
      url: this.getDefaultURL(fragment),
      data: {
        description,
        isEdition: true
      },
      category: 'art',
      vendor: VendorName.KNOWN_ORIGIN,
      chainId: Number(config.get('CHAIN_ID')!),
      network: Network.ETHEREUM,
      issuedId: null,
      itemId: null,
      createdAt: 0,
      updatedAt: 0,
      soldAt: 0
    }
  }

  toOrder(
    edition: EditionFragment,
    oneEthInMANA: string
  ): Order & { ethPrice: string } {
    const totalWei = this.marketplacePrice.addFee(edition.priceInWei)
    const weiPrice = ethers.BigNumber.from(totalWei).mul(oneEthInMANA)
    const price = weiPrice.div(this.oneEthInWei)

    const contractNames = getContractNames()

    const contractAddress = getContract({
      name: contractNames.DIGITAL_ASSET
    }).address
    const marketplaceAddress = getContract({
      name: contractNames.MARKETPLACE_ADAPTER
    }).address

    return {
      id: `${VendorName.KNOWN_ORIGIN}-order-${edition.id}`,
      tokenId: edition.id,
      contractAddress,
      marketplaceAddress,
      owner: edition.artistAccount,
      buyer: null,
      price: price.toString(),
      ethPrice: edition.priceInWei.toString(),
      status: ListingStatus.OPEN,
      createdAt: +edition.createdTimestamp,
      updatedAt: +edition.createdTimestamp,
      expiresAt: Infinity,
      network: Network.ETHEREUM,
      chainId: Number(config.get('CHAIN_ID')!)
    }
  }

  toAccount(address: string): Account {
    return {
      id: address,
      address,
      nftIds: []
    }
  }

  private getAPI(filters?: NFTsFetchFilters) {
    return filters && filters.isToken ? tokenAPI : editionAPI
  }

  private async getOneEthInMANA() {
    const mana = await this.tokenConverter.marketEthToMANA(1)
    return ethers.utils.formatEther(mana.toString())
  }

  private getOwner(fragment: Fragment): string {
    return fragment.type === AssetType.TOKEN
      ? fragment.currentOwner.id
      : fragment.artistAccount
  }

  private getDefaultURL(fragment: Fragment): string {
    const origin = getOriginURL(VendorName.KNOWN_ORIGIN)
    return `${origin}/${fragment.type}/${fragment.id}`
  }
}
